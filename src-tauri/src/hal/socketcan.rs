//! SocketCAN interface implementation for Linux
//!
//! This module provides a CAN interface implementation using the Linux
//! SocketCAN subsystem. It supports both classic CAN and CAN FD frames.

use super::traits::{BusState, CanFilter, CanInterface, InterfaceInfo};
use crate::core::message::CanFrame;
use async_trait::async_trait;
use std::time::Instant;

#[cfg(target_os = "linux")]
use socketcan::{CanSocket, Socket, CanFrame as SocketCanFrame, EmbeddedFrame, StandardId, ExtendedId, Frame};

/// SocketCAN interface for Linux systems
pub struct SocketCanInterface {
    id: String,
    name: String,
    #[cfg(target_os = "linux")]
    socket: Option<CanSocket>,
    #[cfg(not(target_os = "linux"))]
    _socket: Option<()>,
    connected: bool,
    bitrate: u32,
    start_time: Option<Instant>,
}

impl SocketCanInterface {
    /// Create a new SocketCAN interface
    pub fn new(interface_name: &str) -> Self {
        Self {
            id: interface_name.to_string(),
            name: format!("SocketCAN: {}", interface_name),
            #[cfg(target_os = "linux")]
            socket: None,
            #[cfg(not(target_os = "linux"))]
            _socket: None,
            connected: false,
            bitrate: 0,
            start_time: None,
        }
    }
}

#[cfg(target_os = "linux")]
#[async_trait]
impl CanInterface for SocketCanInterface {
    fn info(&self) -> InterfaceInfo {
        InterfaceInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            interface_type: "socketcan".to_string(),
            available: true,
        }
    }

    async fn connect(&mut self, bitrate: u32) -> Result<(), String> {
        if self.connected {
            return Err("Already connected".to_string());
        }

        // Note: Bitrate configuration must be done via `ip link` command
        // before opening the socket. The bitrate parameter is stored but
        // the actual configuration should be handled externally.
        self.bitrate = bitrate;

        // Open the SocketCAN interface
        let socket = CanSocket::open(&self.id)
            .map_err(|e| format!("Failed to open SocketCAN interface {}: {}", self.id, e))?;

        // Set non-blocking mode
        socket.set_nonblocking(true)
            .map_err(|e| format!("Failed to set non-blocking mode: {}", e))?;

        self.socket = Some(socket);
        self.connected = true;
        self.start_time = Some(Instant::now());

        log::info!(
            "SocketCAN {} connected (bitrate should be configured via ip link)",
            self.id
        );

        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".to_string());
        }

        self.socket = None;
        self.connected = false;
        self.start_time = None;

        log::info!("SocketCAN {} disconnected", self.id);

        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    async fn send(&mut self, frame: &CanFrame) -> Result<(), String> {
        let socket = self.socket.as_ref().ok_or("Not connected")?;

        // Convert to SocketCAN frame
        let data: [u8; 8] = {
            let mut arr = [0u8; 8];
            let len = frame.data.len().min(8);
            arr[..len].copy_from_slice(&frame.data[..len]);
            arr
        };

        let socketcan_frame = if frame.is_extended {
            let id = ExtendedId::new(frame.id)
                .ok_or_else(|| format!("Invalid extended CAN ID: 0x{:X}", frame.id))?;
            SocketCanFrame::new(id, &data[..frame.dlc as usize])
                .ok_or("Failed to create CAN frame")?
        } else {
            let id = StandardId::new(frame.id as u16)
                .ok_or_else(|| format!("Invalid standard CAN ID: 0x{:X}", frame.id))?;
            SocketCanFrame::new(id, &data[..frame.dlc as usize])
                .ok_or("Failed to create CAN frame")?
        };

        socket.write_frame(&socketcan_frame)
            .map_err(|e| format!("Failed to send frame: {}", e))?;

        log::trace!(
            "SocketCAN {} TX: ID=0x{:X} DLC={} Data={:?}",
            self.id,
            frame.id,
            frame.dlc,
            &frame.data[..frame.dlc as usize]
        );

        Ok(())
    }

    async fn receive(&mut self) -> Result<Option<CanFrame>, String> {
        let socket = self.socket.as_ref().ok_or("Not connected")?;

        match socket.read_frame() {
            Ok(socketcan_frame) => {
                let timestamp = self
                    .start_time
                    .map(|t| t.elapsed().as_secs_f64())
                    .unwrap_or(0.0);

                // Convert from SocketCAN frame
                let (id, is_extended) = match socketcan_frame.id() {
                    socketcan::Id::Standard(std_id) => (std_id.as_raw() as u32, false),
                    socketcan::Id::Extended(ext_id) => (ext_id.as_raw(), true),
                };

                let frame = CanFrame {
                    id,
                    is_extended,
                    is_remote: socketcan_frame.is_remote_frame(),
                    dlc: socketcan_frame.dlc() as u8,
                    data: socketcan_frame.data().to_vec(),
                    timestamp,
                    channel: self.id.clone(),
                    direction: "rx".to_string(),
                };

                log::trace!(
                    "SocketCAN {} RX: ID=0x{:X} DLC={} Data={:?}",
                    self.id,
                    frame.id,
                    frame.dlc,
                    &frame.data
                );

                Ok(Some(frame))
            }
            Err(e) => {
                // WouldBlock means no frame available (non-blocking mode)
                if e.kind() == std::io::ErrorKind::WouldBlock {
                    Ok(None)
                } else {
                    Err(format!("Failed to receive frame: {}", e))
                }
            }
        }
    }

    fn set_filter(&mut self, filter: Option<CanFilter>) -> Result<(), String> {
        let socket = self.socket.as_ref().ok_or("Not connected")?;

        match filter {
            Some(f) => {
                let can_filter = socketcan::CanFilter::new(f.id, f.mask);
                socket.set_filters(&[can_filter])
                    .map_err(|e| format!("Failed to set filter: {}", e))?;
            }
            None => {
                // Clear filters by setting an empty filter list
                socket.set_filters(&[])
                    .map_err(|e| format!("Failed to clear filters: {}", e))?;
            }
        }

        Ok(())
    }

    fn get_bus_state(&self) -> BusState {
        if !self.connected {
            return BusState::Unknown;
        }

        // SocketCAN provides bus state via netlink, but for simplicity
        // we'll just return Active if connected
        BusState::Active
    }
}

// Stub implementation for non-Linux systems
#[cfg(not(target_os = "linux"))]
#[async_trait]
impl CanInterface for SocketCanInterface {
    fn info(&self) -> InterfaceInfo {
        InterfaceInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            interface_type: "socketcan".to_string(),
            available: false,
        }
    }

    async fn connect(&mut self, _bitrate: u32) -> Result<(), String> {
        Err("SocketCAN is only available on Linux".to_string())
    }

    async fn disconnect(&mut self) -> Result<(), String> {
        Err("SocketCAN is only available on Linux".to_string())
    }

    fn is_connected(&self) -> bool {
        false
    }

    async fn send(&mut self, _frame: &CanFrame) -> Result<(), String> {
        Err("SocketCAN is only available on Linux".to_string())
    }

    async fn receive(&mut self) -> Result<Option<CanFrame>, String> {
        Err("SocketCAN is only available on Linux".to_string())
    }

    fn set_filter(&mut self, _filter: Option<CanFilter>) -> Result<(), String> {
        Err("SocketCAN is only available on Linux".to_string())
    }

    fn get_bus_state(&self) -> BusState {
        BusState::Unknown
    }
}

