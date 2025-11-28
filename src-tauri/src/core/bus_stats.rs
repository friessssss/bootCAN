use serde::{Deserialize, Serialize};

/// Statistics for a CAN bus channel
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusStats {
    /// Estimated bus load percentage (0-100)
    pub bus_load: f64,
    /// Total number of transmitted frames
    pub tx_count: u64,
    /// Total number of received frames
    pub rx_count: u64,
    /// Total number of error frames detected
    pub error_count: u64,
    /// Transmit error counter (TEC)
    pub tx_error_counter: u8,
    /// Receive error counter (REC)
    pub rx_error_counter: u8,
}

impl BusStats {
    /// Create new empty statistics
    pub fn new() -> Self {
        Self::default()
    }

    /// Reset all counters to zero
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// Increment TX count
    pub fn record_tx(&mut self) {
        self.tx_count += 1;
    }

    /// Increment RX count
    pub fn record_rx(&mut self) {
        self.rx_count += 1;
    }

    /// Record an error
    pub fn record_error(&mut self) {
        self.error_count += 1;
    }

    /// Update bus load estimate
    /// This is a simplified calculation based on message rate
    pub fn update_bus_load(&mut self, messages_per_second: f64, bitrate: u32) {
        // Assume average message is ~100 bits (including overhead)
        // Bus load = (bits transmitted per second) / bitrate * 100
        let bits_per_message = 100.0;
        let bits_per_second = messages_per_second * bits_per_message;
        self.bus_load = (bits_per_second / bitrate as f64 * 100.0).min(100.0);
    }
}

/// Extended statistics with timing information
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtendedBusStats {
    /// Basic statistics
    #[serde(flatten)]
    pub base: BusStats,
    /// Average message rate (messages per second)
    pub msg_rate: f64,
    /// Timestamp of first message
    pub first_msg_time: Option<f64>,
    /// Timestamp of last message
    pub last_msg_time: Option<f64>,
    /// Number of unique message IDs seen
    pub unique_ids: u32,
}

