use super::bus_stats::BusStats;
use super::filter::FilterSet;
use super::message::CanFrame;
use super::trace_buffer::TraceRecorder;
use crate::hal::traits::CanInterface;
use crate::hal::virtual_can::VirtualCanInterface;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast;

/// Connection state for a CAN channel
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelState {
    Disconnected,
    Connecting,
    Connected,
    Error(String),
}

/// Configuration for a CAN channel
#[derive(Debug, Clone)]
pub struct ChannelConfig {
    pub interface_id: String,
    pub bitrate: u32,
    pub listen_only: bool,
}

impl Default for ChannelConfig {
    fn default() -> Self {
        Self {
            interface_id: String::new(),
            bitrate: 500_000,
            listen_only: false,
        }
    }
}

/// A single CAN channel representing a connection to a CAN interface
pub struct Channel {
    pub id: String,
    pub config: ChannelConfig,
    pub state: ChannelState,
    pub stats: BusStats,
    interface: Option<Box<dyn CanInterface>>,
    start_time: Option<Instant>,
    message_tx: broadcast::Sender<CanFrame>,
    filter: FilterSet,
    /// Background trace. Recording is gated inside the recorder, so this can
    /// stay attached across start/stop.
    recorder: Option<TraceRecorder>,
}

impl Channel {
    /// Create a new channel
    pub fn new(id: String) -> Self {
        // Large capacity so the trace-logger subscriber can't lag under flood
        let (message_tx, _) = broadcast::channel(65_536);
        Self {
            id,
            config: ChannelConfig::default(),
            state: ChannelState::Disconnected,
            stats: BusStats::new(),
            interface: None,
            start_time: None,
            message_tx,
            filter: FilterSet::default(),
            recorder: None,
        }
    }

    /// Attach the app-wide trace recorder. Frames are stored only while it is running.
    pub fn attach_recorder(&mut self, recorder: TraceRecorder) {
        self.recorder = Some(recorder);
    }

    /// Get a receiver for incoming messages
    pub fn subscribe(&self) -> broadcast::Receiver<CanFrame> {
        self.message_tx.subscribe()
    }

    /// Connect to the CAN interface
    pub fn connect(&mut self, config: ChannelConfig) -> Result<(), String> {
        self.state = ChannelState::Connecting;
        self.config = config.clone();

        // Create appropriate interface based on ID
        let interface: Box<dyn CanInterface> = if config.interface_id.starts_with("vcan") {
            Box::new(VirtualCanInterface::new(&config.interface_id))
        } else if config.interface_id.starts_with("can") {
            #[cfg(target_os = "linux")]
            {
                use crate::hal::socketcan::SocketCanInterface;
                Box::new(SocketCanInterface::new(&config.interface_id))
            }
            #[cfg(not(target_os = "linux"))]
            {
                return Err("SocketCAN is only available on Linux".to_string());
            }
        } else if config.interface_id.starts_with("pcan") {
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            {
                use crate::hal::pcan::PcanInterface;
                Box::new(PcanInterface::new(&config.interface_id))
            }
            #[cfg(target_os = "linux")]
            {
                // On Linux, prefer SocketCAN for PCAN devices
                return Err("On Linux, PCAN devices should be accessed via SocketCAN".to_string());
            }
        } else {
            return Err(format!("Unknown interface type: {}", config.interface_id));
        };

        // Store the interface and connect
        self.interface = Some(interface);

        if let Some(ref mut iface) = self.interface {
            match iface.connect(config.bitrate) {
                Ok(()) => {
                    self.state = ChannelState::Connected;
                    self.start_time = Some(Instant::now());
                    self.stats.reset();
                    Ok(())
                }
                Err(e) => {
                    self.state = ChannelState::Error(e.clone());
                    self.interface = None;
                    Err(e)
                }
            }
        } else {
            Err("Interface not initialized".to_string())
        }
    }

    /// Disconnect from the CAN interface
    pub fn disconnect(&mut self) -> Result<(), String> {
        if let Some(ref mut iface) = self.interface {
            iface.disconnect()?;
        }
        self.interface = None;
        self.state = ChannelState::Disconnected;
        self.start_time = None;
        Ok(())
    }

    /// Send a CAN frame
    pub fn send(&mut self, frame: CanFrame) -> Result<(), String> {
        if self.state != ChannelState::Connected {
            return Err("Channel not connected".to_string());
        }

        if let Some(ref mut iface) = self.interface {
            iface.send(&frame)?;
            self.stats.record_tx(frame.dlc);

            // Broadcast the sent frame
            let mut sent_frame = frame;
            sent_frame.direction = "tx".to_string();
            sent_frame.channel = self.id.clone();
            if let Some(start) = self.start_time {
                sent_frame.timestamp = start.elapsed().as_secs_f64();
            }
            if let Some(recorder) = &self.recorder {
                recorder.record(&sent_frame);
            }
            let _ = self.message_tx.send(sent_frame);

            Ok(())
        } else {
            Err("No interface connected".to_string())
        }
    }

    /// Drain up to `max` received frames (non-blocking).
    ///
    /// Stamps channel/direction, applies the software filter, records stats,
    /// and broadcasts each passing frame to subscribers (trace logger).
    /// Driver-provided (hardware) timestamps are preserved; frames without one
    /// (timestamp == 0.0) are stamped with time-since-connect.
    ///
    /// An `Err` means the interface failed fatally (e.g. device unplugged).
    pub fn receive_batch(&mut self, max: usize) -> Result<Vec<CanFrame>, String> {
        if self.state != ChannelState::Connected {
            return Ok(Vec::new());
        }

        let Some(ref mut iface) = self.interface else {
            return Ok(Vec::new());
        };

        let raw = match iface.receive_batch(max) {
            Ok(frames) => frames,
            Err(e) => {
                self.stats.record_error();
                self.state = ChannelState::Error(e.clone());
                return Err(e);
            }
        };

        let mut out = Vec::with_capacity(raw.len());
        for mut frame in raw {
            self.stats.record_rx(frame.dlc);
            frame.direction = "rx".to_string();
            frame.channel = self.id.clone();
            if frame.timestamp == 0.0 {
                if let Some(start) = self.start_time {
                    frame.timestamp = start.elapsed().as_secs_f64();
                }
            }
            // Trace the bus itself. The receive-list filter only affects the UI.
            if let Some(recorder) = &self.recorder {
                recorder.record(&frame);
            }
            if self.filter.matches(&frame) {
                let _ = self.message_tx.send(frame.clone());
                out.push(frame);
            }
        }
        Ok(out)
    }

    /// Current bus state as reported by the interface driver.
    pub fn get_bus_state(&self) -> crate::hal::traits::BusState {
        self.interface
            .as_ref()
            .map(|i| i.get_bus_state())
            .unwrap_or_default()
    }

    /// Get current timestamp relative to connection start
    pub fn get_timestamp(&self) -> f64 {
        self.start_time
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0)
    }

    /// Set filter for this channel
    pub fn set_filter(&mut self, filter: FilterSet) {
        self.filter = filter;
    }

    /// Get current filter
    pub fn get_filter(&self) -> &FilterSet {
        &self.filter
    }
}

/// Manager for multiple CAN channels
pub struct ChannelManager {
    channels: HashMap<String, Arc<RwLock<Channel>>>,
    active_channel: Option<String>,
}

impl ChannelManager {
    /// Create a new channel manager
    pub fn new() -> Self {
        Self {
            channels: HashMap::new(),
            active_channel: None,
        }
    }

    /// Get or create a channel
    pub fn get_or_create_channel(&mut self, id: &str) -> Arc<RwLock<Channel>> {
        self.channels
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(RwLock::new(Channel::new(id.to_string()))))
            .clone()
    }

    /// Get the active channel
    pub fn get_active_channel(&self) -> Option<Arc<RwLock<Channel>>> {
        self.active_channel
            .as_ref()
            .and_then(|id| self.channels.get(id))
            .cloned()
    }

    /// Get the active channel ID
    pub fn get_active_channel_id(&self) -> Option<&String> {
        self.active_channel.as_ref()
    }

    /// Set the active channel
    pub fn set_active_channel(&mut self, id: &str) {
        if self.channels.contains_key(id) {
            self.active_channel = Some(id.to_string());
        }
    }

    /// Every channel, connected or not.
    pub fn channels(&self) -> Vec<Arc<RwLock<Channel>>> {
        self.channels.values().cloned().collect()
    }

    /// Get all channel IDs
    pub fn get_channel_ids(&self) -> Vec<String> {
        self.channels.keys().cloned().collect()
    }

    /// Remove a channel
    pub fn remove_channel(&mut self, id: &str) {
        self.channels.remove(id);
        if self.active_channel.as_deref() == Some(id) {
            self.active_channel = None;
        }
    }

    /// Get a channel by ID
    pub fn get_channel(&self, id: &str) -> Option<Arc<RwLock<Channel>>> {
        self.channels.get(id).cloned()
    }
}

impl Default for ChannelManager {
    fn default() -> Self {
        Self::new()
    }
}
