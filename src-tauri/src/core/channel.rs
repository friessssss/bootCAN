use super::bus_stats::BusStats;
use super::message::CanFrame;
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
}

impl Channel {
    /// Create a new channel
    pub fn new(id: String) -> Self {
        let (message_tx, _) = broadcast::channel(1000);
        Self {
            id,
            config: ChannelConfig::default(),
            state: ChannelState::Disconnected,
            stats: BusStats::new(),
            interface: None,
            start_time: None,
            message_tx,
        }
    }

    /// Get a receiver for incoming messages
    pub fn subscribe(&self) -> broadcast::Receiver<CanFrame> {
        self.message_tx.subscribe()
    }

    /// Connect to the CAN interface
    pub async fn connect(&mut self, config: ChannelConfig) -> Result<(), String> {
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
            match iface.connect(config.bitrate).await {
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
    pub async fn disconnect(&mut self) -> Result<(), String> {
        if let Some(ref mut iface) = self.interface {
            iface.disconnect().await?;
        }
        self.interface = None;
        self.state = ChannelState::Disconnected;
        self.start_time = None;
        Ok(())
    }

    /// Send a CAN frame
    pub async fn send(&mut self, frame: CanFrame) -> Result<(), String> {
        if self.state != ChannelState::Connected {
            return Err("Channel not connected".to_string());
        }

        if let Some(ref mut iface) = self.interface {
            iface.send(&frame).await?;
            self.stats.record_tx();

            // Broadcast the sent frame
            let mut sent_frame = frame;
            sent_frame.direction = "tx".to_string();
            sent_frame.channel = self.id.clone();
            if let Some(start) = self.start_time {
                sent_frame.timestamp = start.elapsed().as_secs_f64();
            }
            let _ = self.message_tx.send(sent_frame);

            Ok(())
        } else {
            Err("No interface connected".to_string())
        }
    }

    /// Receive a CAN frame (non-blocking)
    pub async fn receive(&mut self) -> Result<Option<CanFrame>, String> {
        if self.state != ChannelState::Connected {
            return Ok(None);
        }

        if let Some(ref mut iface) = self.interface {
            match iface.receive().await {
                Ok(Some(mut frame)) => {
                    self.stats.record_rx();
                    frame.direction = "rx".to_string();
                    frame.channel = self.id.clone();
                    if let Some(start) = self.start_time {
                        frame.timestamp = start.elapsed().as_secs_f64();
                    }
                    let _ = self.message_tx.send(frame.clone());
                    Ok(Some(frame))
                }
                Ok(None) => Ok(None),
                Err(e) => {
                    self.stats.record_error();
                    Err(e)
                }
            }
        } else {
            Ok(None)
        }
    }

    /// Get current timestamp relative to connection start
    pub fn get_timestamp(&self) -> f64 {
        self.start_time
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0)
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

    /// Set the active channel
    pub fn set_active_channel(&mut self, id: &str) {
        if self.channels.contains_key(id) {
            self.active_channel = Some(id.to_string());
        }
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
}

impl Default for ChannelManager {
    fn default() -> Self {
        Self::new()
    }
}

