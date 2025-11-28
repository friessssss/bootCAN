use crate::core::message::CanFrame;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Information about an available CAN interface
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceInfo {
    /// Unique identifier for the interface
    pub id: String,
    /// Human-readable name
    pub name: String,
    /// Interface type (socketcan, pcan, virtual)
    #[serde(rename = "type")]
    pub interface_type: String,
    /// Whether the interface is currently available
    pub available: bool,
}

/// Trait for CAN interface implementations
#[async_trait]
pub trait CanInterface: Send + Sync {
    /// Get interface information
    fn info(&self) -> InterfaceInfo;

    /// Connect to the CAN bus with specified bitrate
    async fn connect(&mut self, bitrate: u32) -> Result<(), String>;

    /// Disconnect from the CAN bus
    async fn disconnect(&mut self) -> Result<(), String>;

    /// Check if connected
    fn is_connected(&self) -> bool;

    /// Send a CAN frame
    async fn send(&mut self, frame: &CanFrame) -> Result<(), String>;

    /// Receive a CAN frame (non-blocking, returns None if no frame available)
    async fn receive(&mut self) -> Result<Option<CanFrame>, String>;

    /// Set receive filter (pass None to receive all)
    fn set_filter(&mut self, filter: Option<CanFilter>) -> Result<(), String>;

    /// Get current bus state
    fn get_bus_state(&self) -> BusState;
}

/// CAN message filter
#[derive(Debug, Clone)]
pub struct CanFilter {
    /// Filter ID
    pub id: u32,
    /// Filter mask (bits set to 1 must match)
    pub mask: u32,
    /// Match extended IDs
    pub extended: bool,
}

impl CanFilter {
    /// Create a filter that matches a single ID
    pub fn single(id: u32, extended: bool) -> Self {
        Self {
            id,
            mask: if extended { 0x1FFFFFFF } else { 0x7FF },
            extended,
        }
    }

    /// Create a filter that matches a range of IDs
    pub fn range(start: u32, end: u32, extended: bool) -> Self {
        // Calculate mask that covers the range
        let diff = start ^ end;
        let mask = if extended { 0x1FFFFFFF } else { 0x7FF } ^ diff;
        Self {
            id: start,
            mask,
            extended,
        }
    }

    /// Create a filter that matches all IDs
    pub fn all() -> Self {
        Self {
            id: 0,
            mask: 0,
            extended: false,
        }
    }
}

/// CAN bus state
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BusState {
    /// Bus is in active state (normal operation)
    Active,
    /// Bus is in warning state (error counters elevated)
    Warning,
    /// Bus is in passive state (high error counts)
    Passive,
    /// Bus is off (too many errors)
    BusOff,
    /// Unknown or not connected
    Unknown,
}

impl Default for BusState {
    fn default() -> Self {
        Self::Unknown
    }
}

/// Enumerates available CAN interfaces on the system
pub fn enumerate_interfaces() -> Vec<InterfaceInfo> {
    let mut interfaces = Vec::new();

    // Always add virtual CAN interfaces
    interfaces.push(InterfaceInfo {
        id: "vcan0".to_string(),
        name: "Virtual CAN 0".to_string(),
        interface_type: "virtual".to_string(),
        available: true,
    });

    interfaces.push(InterfaceInfo {
        id: "vcan1".to_string(),
        name: "Virtual CAN 1".to_string(),
        interface_type: "virtual".to_string(),
        available: true,
    });

    // Enumerate SocketCAN interfaces on Linux
    #[cfg(target_os = "linux")]
    {
        if let Ok(socketcan_interfaces) = enumerate_socketcan_interfaces() {
            interfaces.extend(socketcan_interfaces);
        }
    }

    // Enumerate PCAN interfaces on Windows/macOS
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        if let Ok(pcan_interfaces) = enumerate_pcan_interfaces() {
            interfaces.extend(pcan_interfaces);
        }
    }

    interfaces
}

#[cfg(target_os = "linux")]
fn enumerate_socketcan_interfaces() -> Result<Vec<InterfaceInfo>, String> {
    use std::fs;

    let mut interfaces = Vec::new();

    // Read network interfaces from /sys/class/net
    if let Ok(entries) = fs::read_dir("/sys/class/net") {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            
            // Check if it's a CAN interface by looking for the can protocol
            let type_path = entry.path().join("type");
            if let Ok(type_str) = fs::read_to_string(&type_path) {
                let type_num: u32 = type_str.trim().parse().unwrap_or(0);
                // ARPHRD_CAN = 280
                if type_num == 280 || name.starts_with("can") || name.starts_with("vcan") {
                    // Skip vcan interfaces as they're added separately
                    if !name.starts_with("vcan") {
                        interfaces.push(InterfaceInfo {
                            id: name.clone(),
                            name: format!("SocketCAN: {}", name),
                            interface_type: "socketcan".to_string(),
                            available: true,
                        });
                    }
                }
            }
        }
    }

    Ok(interfaces)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn enumerate_pcan_interfaces() -> Result<Vec<InterfaceInfo>, String> {
    // PCAN USB device enumeration
    // In a real implementation, this would call the PCAN API to enumerate devices
    let interfaces = vec![
        InterfaceInfo {
            id: "pcan_usb1".to_string(),
            name: "PCAN-USB 1".to_string(),
            interface_type: "pcan".to_string(),
            // Would check actual availability via PCAN API
            available: false,
        },
        InterfaceInfo {
            id: "pcan_usb2".to_string(),
            name: "PCAN-USB 2".to_string(),
            interface_type: "pcan".to_string(),
            available: false,
        },
    ];

    Ok(interfaces)
}

