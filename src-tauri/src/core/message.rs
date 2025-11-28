use serde::{Deserialize, Serialize};

/// Standard CAN frame representation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanFrame {
    /// CAN identifier (11-bit standard or 29-bit extended)
    pub id: u32,
    /// Whether this is an extended (29-bit) ID
    pub is_extended: bool,
    /// Whether this is a remote transmission request
    pub is_remote: bool,
    /// Data length code (0-8 for classic CAN, 0-64 for CAN FD)
    pub dlc: u8,
    /// Frame data bytes
    pub data: Vec<u8>,
    /// Timestamp in seconds since connection start
    pub timestamp: f64,
    /// Channel identifier this message was sent/received on
    pub channel: String,
    /// Direction: "rx" for received, "tx" for transmitted
    pub direction: String,
}

impl Default for CanFrame {
    fn default() -> Self {
        Self {
            id: 0,
            is_extended: false,
            is_remote: false,
            dlc: 0,
            data: vec![],
            timestamp: 0.0,
            channel: String::new(),
            direction: "rx".to_string(),
        }
    }
}

impl CanFrame {
    /// Create a new CAN frame
    pub fn new(id: u32, data: &[u8]) -> Self {
        let dlc = data.len().min(8) as u8;
        Self {
            id,
            is_extended: id > 0x7FF,
            is_remote: false,
            dlc,
            data: data[..dlc as usize].to_vec(),
            timestamp: 0.0,
            channel: String::new(),
            direction: "tx".to_string(),
        }
    }

    /// Create a new extended CAN frame
    pub fn new_extended(id: u32, data: &[u8]) -> Self {
        let dlc = data.len().min(8) as u8;
        Self {
            id,
            is_extended: true,
            is_remote: false,
            dlc,
            data: data[..dlc as usize].to_vec(),
            timestamp: 0.0,
            channel: String::new(),
            direction: "tx".to_string(),
        }
    }

    /// Create a remote transmission request frame
    pub fn new_rtr(id: u32, dlc: u8) -> Self {
        Self {
            id,
            is_extended: id > 0x7FF,
            is_remote: true,
            dlc: dlc.min(8),
            data: vec![],
            timestamp: 0.0,
            channel: String::new(),
            direction: "tx".to_string(),
        }
    }

    /// Set the frame as received
    pub fn as_received(mut self, channel: &str, timestamp: f64) -> Self {
        self.direction = "rx".to_string();
        self.channel = channel.to_string();
        self.timestamp = timestamp;
        self
    }

    /// Set the frame as transmitted
    pub fn as_transmitted(mut self, channel: &str, timestamp: f64) -> Self {
        self.direction = "tx".to_string();
        self.channel = channel.to_string();
        self.timestamp = timestamp;
        self
    }

    /// Get the formatted ID as hex string
    pub fn id_hex(&self) -> String {
        if self.is_extended {
            format!("{:08X}", self.id)
        } else {
            format!("{:03X}", self.id)
        }
    }

    /// Get the formatted data as hex string
    pub fn data_hex(&self) -> String {
        self.data
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// CAN FD frame with additional FD-specific fields
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanFdFrame {
    /// Base CAN frame
    #[serde(flatten)]
    pub base: CanFrame,
    /// Bit Rate Switch flag (data phase at higher bitrate)
    pub brs: bool,
    /// Error State Indicator
    pub esi: bool,
}

impl CanFdFrame {
    /// Create a new CAN FD frame
    pub fn new(id: u32, data: &[u8], brs: bool) -> Self {
        let dlc = data.len().min(64) as u8;
        Self {
            base: CanFrame {
                id,
                is_extended: id > 0x7FF,
                is_remote: false,
                dlc,
                data: data[..dlc as usize].to_vec(),
                timestamp: 0.0,
                channel: String::new(),
                direction: "tx".to_string(),
            },
            brs,
            esi: false,
        }
    }
}

/// Frame that can be sent to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePayload {
    pub id: u32,
    pub is_extended: bool,
    pub is_remote: bool,
    pub dlc: u8,
    pub data: Vec<u8>,
    #[serde(default)]
    pub channel: Option<String>,
}

impl From<&CanFrame> for FramePayload {
    fn from(frame: &CanFrame) -> Self {
        Self {
            id: frame.id,
            is_extended: frame.is_extended,
            is_remote: frame.is_remote,
            dlc: frame.dlc,
            data: frame.data.clone(),
            channel: if frame.channel.is_empty() {
                None
            } else {
                Some(frame.channel.clone())
            },
        }
    }
}

impl From<FramePayload> for CanFrame {
    fn from(payload: FramePayload) -> Self {
        Self {
            id: payload.id,
            is_extended: payload.is_extended,
            is_remote: payload.is_remote,
            dlc: payload.dlc,
            data: payload.data,
            timestamp: 0.0,
            channel: payload.channel.unwrap_or_default(),
            direction: "tx".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_frame_new() {
        let frame = CanFrame::new(0x123, &[0x01, 0x02, 0x03, 0x04]);
        assert_eq!(frame.id, 0x123);
        assert_eq!(frame.dlc, 4);
        assert!(!frame.is_extended);
        assert!(!frame.is_remote);
    }

    #[test]
    fn test_can_frame_extended() {
        let frame = CanFrame::new_extended(0x12345678, &[0xAA, 0xBB]);
        assert_eq!(frame.id, 0x12345678);
        assert!(frame.is_extended);
    }

    #[test]
    fn test_can_frame_id_hex() {
        let standard = CanFrame::new(0x123, &[]);
        assert_eq!(standard.id_hex(), "123");

        let extended = CanFrame::new_extended(0x12345678, &[]);
        assert_eq!(extended.id_hex(), "12345678");
    }
}

