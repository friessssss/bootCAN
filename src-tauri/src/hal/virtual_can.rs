use super::traits::{BusState, CanFilter, CanInterface, InterfaceInfo};
use crate::core::message::CanFrame;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

/// Virtual CAN interface for testing without hardware
///
/// This interface provides a loopback mechanism where transmitted frames
/// are echoed back as received frames. Useful for development and testing.
pub struct VirtualCanInterface {
    id: String,
    name: String,
    connected: bool,
    bitrate: u32,
    filter: Option<CanFilter>,
    rx_buffer: Arc<Mutex<VecDeque<CanFrame>>>,
    start_time: Option<Instant>,
}

impl VirtualCanInterface {
    /// Create a new virtual CAN interface
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            name: format!("Virtual CAN: {}", id),
            connected: false,
            bitrate: 0,
            filter: None,
            rx_buffer: Arc::new(Mutex::new(VecDeque::with_capacity(1000))),
            start_time: None,
        }
    }

    /// Get the receive buffer for external access (e.g., for simulation)
    #[allow(dead_code)]
    pub fn get_rx_buffer(&self) -> Arc<Mutex<VecDeque<CanFrame>>> {
        self.rx_buffer.clone()
    }

    /// Inject a frame into the receive buffer (for simulation)
    pub fn inject_frame(&self, frame: CanFrame) {
        let mut buffer = self.rx_buffer.lock();
        if buffer.len() >= 1000 {
            buffer.pop_front();
        }
        buffer.push_back(frame);
    }

    /// Check if frame passes the current filter
    fn passes_filter(&self, frame: &CanFrame) -> bool {
        match &self.filter {
            None => true,
            Some(filter) => {
                if filter.extended != frame.is_extended {
                    return false;
                }
                (frame.id & filter.mask) == (filter.id & filter.mask)
            }
        }
    }
}

impl CanInterface for VirtualCanInterface {
    fn info(&self) -> InterfaceInfo {
        InterfaceInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            interface_type: "virtual".to_string(),
            available: true,
            ..Default::default()
        }
    }

    fn connect(&mut self, bitrate: u32) -> Result<(), String> {
        if self.connected {
            return Err("Already connected".to_string());
        }

        self.bitrate = bitrate;
        self.connected = true;
        self.start_time = Some(Instant::now());
        self.rx_buffer.lock().clear();

        log::info!("Virtual CAN {} connected at {} bps", self.id, bitrate);

        Ok(())
    }

    fn disconnect(&mut self) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".to_string());
        }

        self.connected = false;
        self.start_time = None;
        self.rx_buffer.lock().clear();

        log::info!("Virtual CAN {} disconnected", self.id);

        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn send(&mut self, frame: &CanFrame) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".to_string());
        }

        // Loopback: echo the frame back as received
        let mut echo_frame = frame.clone();
        echo_frame.direction = "rx".to_string();
        echo_frame.channel = self.id.clone();

        if let Some(start) = self.start_time {
            echo_frame.timestamp = start.elapsed().as_secs_f64();
        }

        // Only add to buffer if it passes filter
        if self.passes_filter(&echo_frame) {
            let mut buffer = self.rx_buffer.lock();
            if buffer.len() >= 1000 {
                buffer.pop_front();
            }
            buffer.push_back(echo_frame);
        }

        log::trace!(
            "Virtual CAN {} TX: ID=0x{:X} DLC={} Data={:?}",
            self.id,
            frame.id,
            frame.dlc,
            &frame.data[..frame.dlc as usize]
        );

        Ok(())
    }

    fn receive_batch(&mut self, max: usize) -> Result<Vec<CanFrame>, String> {
        if !self.connected {
            return Err("Not connected".to_string());
        }

        let mut buffer = self.rx_buffer.lock();
        let n = buffer.len().min(max);
        Ok(buffer.drain(..n).collect())
    }

    fn set_filter(&mut self, filter: Option<CanFilter>) -> Result<(), String> {
        self.filter = filter;
        Ok(())
    }

    fn get_bus_state(&self) -> BusState {
        if self.connected {
            BusState::Active
        } else {
            BusState::Unknown
        }
    }
}

/// Shared virtual bus that multiple VirtualCanInterfaces can connect to
/// This allows simulating a real CAN bus with multiple nodes
#[allow(dead_code)]
pub struct VirtualCanBus {
    nodes: Vec<Arc<Mutex<VirtualCanInterface>>>,
}

#[allow(dead_code)]
impl VirtualCanBus {
    /// Create a new virtual CAN bus
    pub fn new() -> Self {
        Self { nodes: Vec::new() }
    }

    /// Add a node to the bus
    pub fn add_node(&mut self, node: Arc<Mutex<VirtualCanInterface>>) {
        self.nodes.push(node);
    }

    /// Broadcast a frame to all nodes (except sender)
    pub fn broadcast(&self, sender_id: &str, frame: &CanFrame) {
        for node in &self.nodes {
            let node = node.lock();
            if node.id != sender_id && node.is_connected() {
                node.inject_frame(frame.clone());
            }
        }
    }
}

impl Default for VirtualCanBus {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_virtual_can_connect_disconnect() {
        let mut vcan = VirtualCanInterface::new("vcan_test");

        assert!(!vcan.is_connected());

        vcan.connect(500_000).unwrap();
        assert!(vcan.is_connected());

        vcan.disconnect().unwrap();
        assert!(!vcan.is_connected());
    }

    #[test]
    fn test_virtual_can_loopback() {
        let mut vcan = VirtualCanInterface::new("vcan_test");
        vcan.connect(500_000).unwrap();

        let frame = CanFrame::new(0x123, &[1, 2, 3, 4]);
        vcan.send(&frame).unwrap();

        let received = vcan.receive_batch(64).unwrap();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].id, 0x123);
        assert_eq!(received[0].data, vec![1, 2, 3, 4]);
    }

    #[test]
    fn test_virtual_can_filter() {
        let mut vcan = VirtualCanInterface::new("vcan_test");
        vcan.connect(500_000).unwrap();

        // Set filter to only accept ID 0x200
        vcan.set_filter(Some(CanFilter::single(0x200, false))).unwrap();

        // Send a frame that doesn't match
        let frame1 = CanFrame::new(0x123, &[1, 2, 3, 4]);
        vcan.send(&frame1).unwrap();

        // Should not receive it
        assert!(vcan.receive_batch(64).unwrap().is_empty());

        // Send a frame that matches
        let frame2 = CanFrame::new(0x200, &[5, 6, 7, 8]);
        vcan.send(&frame2).unwrap();

        // Should receive it
        let received = vcan.receive_batch(64).unwrap();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].id, 0x200);
    }

    #[test]
    fn test_receive_batch_drains_in_order() {
        let mut vcan = VirtualCanInterface::new("vcan_test");
        vcan.connect(500_000).unwrap();

        for i in 0..10u8 {
            vcan.send(&CanFrame::new(0x100 + i as u32, &[i])).unwrap();
        }

        let first = vcan.receive_batch(4).unwrap();
        assert_eq!(first.len(), 4);
        assert_eq!(first[0].id, 0x100);
        assert_eq!(first[3].id, 0x103);

        let rest = vcan.receive_batch(100).unwrap();
        assert_eq!(rest.len(), 6);
        assert_eq!(rest[5].id, 0x109);
    }
}
