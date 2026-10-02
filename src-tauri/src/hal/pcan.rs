//! PCAN (PEAK-System) interface implementation
//!
//! Talks to PCAN-USB adapters through the PCAN-Basic compatible API loaded at
//! runtime by [`super::pcbusb`] (MacCAN PCBUSB on macOS, PCANBasic.dll on
//! Windows). A dedicated OS reader thread blocks on the driver's receive
//! event and drains frames into a bounded channel; `receive_batch` is a cheap
//! non-blocking drain of that channel.

use super::pcbusb::{self, PcbusbApi, TPCANMsg, TPCANTimestamp};
use super::traits::{BusState, CanFilter, CanInterface, InterfaceInfo};
use crate::core::message::CanFrame;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Instant;

/// PCAN bitrate register values (BTR0BTR1) for classic CAN.
#[repr(u16)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
pub enum PcanBitrate {
    Baud1M = 0x0014,
    Baud800K = 0x0016,
    Baud500K = 0x001C,
    Baud250K = 0x011C,
    Baud125K = 0x031C,
    Baud100K = 0x432F,
    Baud95K = 0xC34E,
    Baud83K = 0x852B,
    Baud50K = 0x472F,
    Baud47K = 0x1414,
    Baud33K = 0x8B2F,
    Baud20K = 0x532F,
    Baud10K = 0x672F,
    Baud5K = 0x7F7F,
}

impl PcanBitrate {
    pub fn from_bps(bps: u32) -> Result<Self, String> {
        match bps {
            1_000_000 => Ok(Self::Baud1M),
            800_000 => Ok(Self::Baud800K),
            500_000 => Ok(Self::Baud500K),
            250_000 => Ok(Self::Baud250K),
            125_000 => Ok(Self::Baud125K),
            100_000 => Ok(Self::Baud100K),
            83_333 => Ok(Self::Baud83K),
            50_000 => Ok(Self::Baud50K),
            33_333 => Ok(Self::Baud33K),
            20_000 => Ok(Self::Baud20K),
            10_000 => Ok(Self::Baud10K),
            5_000 => Ok(Self::Baud5K),
            _ => Err(format!("Unsupported bitrate: {} bps", bps)),
        }
    }
}

/// Map an interface id like "pcan_usb3" to its PCAN handle (0x51..0x58).
fn handle_from_id(id: &str) -> Option<u16> {
    let n: u16 = id.strip_prefix("pcan_usb")?.parse().ok()?;
    if (1..=8).contains(&n) {
        Some(0x50 + n)
    } else {
        None
    }
}

/// Bus state encoded into an atomic for sharing with the reader thread.
const STATE_UNKNOWN: u8 = 0;
const STATE_ACTIVE: u8 = 1;
const STATE_WARNING: u8 = 2;
const STATE_PASSIVE: u8 = 3;
const STATE_BUSOFF: u8 = 4;

fn decode_state(v: u8) -> BusState {
    match v {
        STATE_ACTIVE => BusState::Active,
        STATE_WARNING => BusState::Warning,
        STATE_PASSIVE => BusState::Passive,
        STATE_BUSOFF => BusState::BusOff,
        _ => BusState::Unknown,
    }
}

fn state_from_status(status: u32) -> u8 {
    if status & pcbusb::PCAN_ERROR_BUSOFF != 0 {
        STATE_BUSOFF
    } else if status & pcbusb::PCAN_ERROR_BUSPASSIVE != 0 {
        STATE_PASSIVE
    } else if status & (pcbusb::PCAN_ERROR_BUSLIGHT | pcbusb::PCAN_ERROR_BUSHEAVY) != 0 {
        STATE_WARNING
    } else {
        STATE_ACTIVE
    }
}

/// How many consecutive unexpected CAN_Read errors before the reader gives up.
/// Unplugging the adapter produces a continuous error stream, so this trips
/// within a few milliseconds while tolerating sporadic glitches.
const MAX_CONSECUTIVE_READ_ERRORS: u32 = 100;
/// Device time further than this from host time means the device clock reset.
const CLOCK_REANCHOR_SECS: f64 = 2.0;

const RX_CHANNEL_CAPACITY: usize = 65_536;

pub struct PcanInterface {
    id: String,
    name: String,
    handle: Option<u16>,
    connected: bool,
    bitrate: u32,
    rx: Option<crossbeam_channel::Receiver<CanFrame>>,
    shutdown: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    bus_state: Arc<AtomicU8>,
    /// Set by the reader thread when it exits due to a fatal driver error
    /// (e.g. the adapter was unplugged).
    reader_dead: Arc<AtomicBool>,
    dropped_frames: Arc<AtomicU64>,
}

impl PcanInterface {
    pub fn new(id: &str) -> Self {
        Self {
            id: id.to_string(),
            name: format!("PCAN: {}", id),
            handle: handle_from_id(id),
            connected: false,
            bitrate: 0,
            rx: None,
            shutdown: Arc::new(AtomicBool::new(false)),
            reader: None,
            bus_state: Arc::new(AtomicU8::new(STATE_UNKNOWN)),
            reader_dead: Arc::new(AtomicBool::new(false)),
            dropped_frames: Arc::new(AtomicU64::new(0)),
        }
    }

    fn teardown(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
        if let Some(ch) = self.handle {
            if let Ok(api) = PcbusbApi::get() {
                unsafe { (api.can_uninitialize)(ch) };
            }
        }
        self.rx = None;
        self.connected = false;
        self.bus_state.store(STATE_UNKNOWN, Ordering::Relaxed);
    }
}

impl Drop for PcanInterface {
    fn drop(&mut self) {
        if self.connected {
            self.teardown();
        }
    }
}

impl CanInterface for PcanInterface {
    fn info(&self) -> InterfaceInfo {
        InterfaceInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            interface_type: "pcan".to_string(),
            available: self.handle.is_some() && PcbusbApi::is_available(),
            ..Default::default()
        }
    }

    fn connect(&mut self, bitrate: u32) -> Result<(), String> {
        if self.connected {
            return Err("Already connected".to_string());
        }
        let handle = self
            .handle
            .ok_or_else(|| format!("Invalid PCAN interface id: {}", self.id))?;
        let api = PcbusbApi::get()?;
        let btr = PcanBitrate::from_bps(bitrate)?;

        let status = unsafe { (api.can_initialize)(handle, btr as u16, 0, 0, 0) };
        if status != pcbusb::PCAN_ERROR_OK {
            return Err(format!(
                "Failed to initialize PCAN channel: {}",
                api.error_text(status)
            ));
        }

        // Receive event fd for blocking reads (POSIX pipe on macOS/PCBUSB).
        // If unavailable we fall back to short-sleep polling in the reader.
        #[cfg(target_os = "macos")]
        let event_fd: Option<i32> = match api.get_u32(handle, pcbusb::PCAN_RECEIVE_EVENT) {
            Ok(fd) => Some(fd as i32),
            Err(rc) => {
                log::warn!(
                    "PCAN_RECEIVE_EVENT unavailable ({}), reader will poll",
                    api.error_text(rc)
                );
                None
            }
        };
        // On Windows PCAN_RECEIVE_EVENT is a pointer-sized Win32 HANDLE that
        // the caller must create and set, so it is not queried; poll instead.
        #[cfg(not(target_os = "macos"))]
        let event_fd: Option<i32> = None;

        let (tx, rx) = crossbeam_channel::bounded::<CanFrame>(RX_CHANNEL_CAPACITY);
        self.rx = Some(rx);
        self.shutdown.store(false, Ordering::Relaxed);
        self.reader_dead.store(false, Ordering::Relaxed);
        self.dropped_frames.store(0, Ordering::Relaxed);
        self.bus_state.store(STATE_ACTIVE, Ordering::Relaxed);

        let shutdown = self.shutdown.clone();
        let reader_dead = self.reader_dead.clone();
        let bus_state = self.bus_state.clone();
        let dropped = self.dropped_frames.clone();
        let iface_id = self.id.clone();

        let reader = std::thread::Builder::new()
            .name(format!("pcan-rx-{}", self.id))
            .spawn(move || {
                reader_loop(
                    handle,
                    event_fd,
                    tx,
                    shutdown,
                    reader_dead,
                    bus_state,
                    dropped,
                    iface_id,
                );
            })
            .map_err(|e| format!("Failed to spawn PCAN reader thread: {}", e))?;
        self.reader = Some(reader);

        self.bitrate = bitrate;
        self.connected = true;
        log::info!("PCAN {} connected at {} bps", self.id, bitrate);
        Ok(())
    }

    fn disconnect(&mut self) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".to_string());
        }
        self.teardown();
        log::info!("PCAN {} disconnected", self.id);
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected && !self.reader_dead.load(Ordering::Relaxed)
    }

    fn send(&mut self, frame: &CanFrame) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".to_string());
        }
        if self.reader_dead.load(Ordering::Relaxed) {
            return Err("PCAN device lost (unplugged?)".to_string());
        }
        let handle = self.handle.ok_or("Invalid PCAN handle")?;
        let api = PcbusbApi::get()?;

        let mut msgtype = 0u8;
        if frame.is_extended {
            msgtype |= pcbusb::PCAN_MESSAGE_EXTENDED;
        }
        if frame.is_remote {
            msgtype |= pcbusb::PCAN_MESSAGE_RTR;
        }
        let mut msg = TPCANMsg {
            id: frame.id,
            msgtype,
            len: frame.dlc.min(8),
            data: [0; 8],
        };
        let n = frame.data.len().min(8);
        msg.data[..n].copy_from_slice(&frame.data[..n]);

        let status = unsafe { (api.can_write)(handle, &mut msg) };
        if status != pcbusb::PCAN_ERROR_OK {
            return Err(format!("PCAN send failed: {}", api.error_text(status)));
        }
        Ok(())
    }

    fn receive_batch(&mut self, max: usize) -> Result<Vec<CanFrame>, String> {
        if !self.connected {
            return Err("Not connected".to_string());
        }
        if self.reader_dead.load(Ordering::Relaxed) {
            return Err("PCAN device lost (unplugged?)".to_string());
        }
        let rx = self.rx.as_ref().ok_or("Receiver not initialized")?;
        Ok(rx.try_iter().take(max).collect())
    }

    fn set_filter(&mut self, filter: Option<CanFilter>) -> Result<(), String> {
        if !self.connected {
            return Err("Not connected".to_string());
        }
        let handle = self.handle.ok_or("Invalid PCAN handle")?;
        let api = PcbusbApi::get()?;
        let status = match filter {
            Some(f) => {
                // Convert id+mask to the bounding id range (a superset of the
                // mask filter — precise filtering stays in software).
                let id_bits = if f.extended { 0x1FFF_FFFF } else { 0x7FF };
                let from = f.id & f.mask & id_bits;
                let to = (f.id | !f.mask) & id_bits;
                let mode = if f.extended { 0x02 } else { 0x00 };
                unsafe { (api.can_filter_messages)(handle, from, to, mode) }
            }
            None => {
                let id_bits = 0x1FFF_FFFF;
                unsafe { (api.can_filter_messages)(handle, 0, id_bits, 0x02) }
            }
        };
        if status != pcbusb::PCAN_ERROR_OK {
            return Err(format!("PCAN filter failed: {}", api.error_text(status)));
        }
        Ok(())
    }

    fn get_bus_state(&self) -> BusState {
        if !self.connected {
            return BusState::Unknown;
        }
        decode_state(self.bus_state.load(Ordering::Relaxed))
    }
}

/// Blocking reader: waits on the driver's receive event (or a short sleep as
/// fallback), then drains CAN_Read until the queue is empty. Runs until
/// shutdown is signaled or a fatal driver error occurs.
#[allow(clippy::too_many_arguments)]
fn reader_loop(
    handle: u16,
    event_fd: Option<i32>,
    tx: crossbeam_channel::Sender<CanFrame>,
    shutdown: Arc<AtomicBool>,
    reader_dead: Arc<AtomicBool>,
    bus_state: Arc<AtomicU8>,
    dropped: Arc<AtomicU64>,
    iface_id: String,
) {
    let api = match PcbusbApi::get() {
        Ok(api) => api,
        Err(e) => {
            log::error!("PCAN reader: API unavailable: {}", e);
            reader_dead.store(true, Ordering::Relaxed);
            return;
        }
    };

    let connect_instant = Instant::now();
    // First-frame anchor: maps device microseconds onto seconds-since-connect.
    let mut t0: Option<(u64, f64)> = None;
    let mut consecutive_errors: u32 = 0;
    let mut logged_drop_warning = false;

    while !shutdown.load(Ordering::Relaxed) {
        wait_for_data(event_fd);
        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        // Drain everything currently queued.
        loop {
            let mut msg = TPCANMsg::default();
            let mut ts = TPCANTimestamp::default();
            let status = unsafe { (api.can_read)(handle, &mut msg, &mut ts) };

            if status & pcbusb::PCAN_ERROR_QRCVEMPTY != 0 {
                consecutive_errors = 0;
                break;
            }
            if status & pcbusb::PCAN_ERROR_QOVERRUN != 0 {
                dropped.fetch_add(1, Ordering::Relaxed);
            }

            if msg.msgtype & pcbusb::PCAN_MESSAGE_STATUS != 0 {
                // Bus state changed — query the authoritative status.
                let st = unsafe { (api.can_get_status)(handle) };
                bus_state.store(state_from_status(st), Ordering::Relaxed);
                consecutive_errors = 0;
                continue;
            }
            if msg.msgtype & pcbusb::PCAN_MESSAGE_ERRFRAME != 0 {
                consecutive_errors = 0;
                continue;
            }

            let read_ok = status == pcbusb::PCAN_ERROR_OK
                || status & pcbusb::PCAN_ERROR_ANYBUSERR != 0
                || status & pcbusb::PCAN_ERROR_QOVERRUN != 0;
            if !read_ok {
                consecutive_errors += 1;
                if consecutive_errors == 1 {
                    log::warn!("PCAN {} read error: {}", iface_id, api.error_text(status));
                }
                if consecutive_errors >= MAX_CONSECUTIVE_READ_ERRORS {
                    log::error!(
                        "PCAN {} reader giving up after {} consecutive errors (device unplugged?)",
                        iface_id,
                        consecutive_errors
                    );
                    bus_state.store(STATE_UNKNOWN, Ordering::Relaxed);
                    reader_dead.store(true, Ordering::Relaxed);
                    return;
                }
                break;
            }
            if status & pcbusb::PCAN_ERROR_ANYBUSERR != 0 {
                bus_state.store(state_from_status(status), Ordering::Relaxed);
            }
            consecutive_errors = 0;

            let device_us = ts.total_micros();
            let now = connect_instant.elapsed().as_secs_f64();
            let timestamp = match t0 {
                Some((base_us, base_secs)) => {
                    let hw = base_secs + device_us.saturating_sub(base_us) as f64 / 1e6;
                    // The device clock can restart or jump (e.g. another channel
                    // on the adapter initialising). Without re-anchoring, every
                    // later frame on this net would share one timestamp.
                    if device_us < base_us || (hw - now).abs() > CLOCK_REANCHOR_SECS {
                        log::warn!(
                            "PCAN {} device clock jumped ({:+.3}s); re-anchoring",
                            iface_id,
                            hw - now
                        );
                        t0 = Some((device_us, now));
                        now
                    } else {
                        hw
                    }
                }
                None => {
                    t0 = Some((device_us, now));
                    now
                }
            };

            let dlc = msg.len.min(8);
            let frame = CanFrame {
                id: msg.id,
                is_extended: msg.msgtype & pcbusb::PCAN_MESSAGE_EXTENDED != 0,
                is_remote: msg.msgtype & pcbusb::PCAN_MESSAGE_RTR != 0,
                dlc,
                data: msg.data[..dlc as usize].to_vec(),
                timestamp,
                channel: String::new(),
                direction: "rx".to_string(),
            };

            if tx.try_send(frame).is_err() {
                let total = dropped.fetch_add(1, Ordering::Relaxed) + 1;
                if !logged_drop_warning {
                    log::warn!(
                        "PCAN {} rx buffer full — dropping frames (total dropped: {})",
                        iface_id,
                        total
                    );
                    logged_drop_warning = true;
                }
            }
        }
    }
}

/// Block until the driver signals pending data, with a 100 ms cap so the loop
/// regularly re-checks the shutdown flag and recovers from missed wakeups.
#[cfg(target_os = "macos")]
fn wait_for_data(event_fd: Option<i32>) {
    match event_fd {
        Some(fd) => unsafe {
            let mut readfds: libc::fd_set = std::mem::zeroed();
            libc::FD_ZERO(&mut readfds);
            libc::FD_SET(fd, &mut readfds);
            let mut tv = libc::timeval {
                tv_sec: 0,
                tv_usec: 100_000,
            };
            // Result deliberately ignored: on wakeup, timeout, or EINTR we
            // drain the queue either way.
            libc::select(
                fd + 1,
                &mut readfds,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut tv,
            );
        },
        None => std::thread::sleep(std::time::Duration::from_millis(1)),
    }
}

#[cfg(not(target_os = "macos"))]
fn wait_for_data(_event_fd: Option<i32>) {
    // On Windows PCAN_RECEIVE_EVENT is a Win32 event handle; polling at 1 ms
    // is a fine fallback until native event support is added.
    std::thread::sleep(std::time::Duration::from_millis(1));
}

/// Probe PCAN-USB channels 1-8 and return only physically attached devices.
/// Returns an empty list when the driver library is not installed.
pub fn enumerate_devices() -> Vec<InterfaceInfo> {
    let api = match PcbusbApi::get() {
        Ok(api) => api,
        Err(_) => return Vec::new(),
    };

    let mut devices = Vec::new();
    for handle in pcbusb::PCAN_USBBUS1..=pcbusb::PCAN_USBBUS8 {
        let cond = match api.get_u32(handle, pcbusb::PCAN_CHANNEL_CONDITION) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let attached = cond & (pcbusb::PCAN_CHANNEL_AVAILABLE | pcbusb::PCAN_CHANNEL_OCCUPIED) != 0;
        if !attached {
            continue;
        }
        let n = handle - 0x50;

        let hardware_name = api
            .get_string(
                handle,
                pcbusb::PCAN_HARDWARE_NAME,
                pcbusb::MAX_LENGTH_HARDWARE_NAME,
            )
            .ok()
            .filter(|s| !s.is_empty());
        let device_id = api.get_u32(handle, pcbusb::PCAN_DEVICE_ID).ok();
        let firmware = api
            .get_string(
                handle,
                pcbusb::PCAN_FIRMWARE_VERSION,
                pcbusb::MAX_LENGTH_VERSION_STRING,
            )
            .ok()
            .filter(|s| !s.is_empty());

        let display_name = match &hardware_name {
            Some(hw) => format!("{} (ch {})", hw, n),
            None => format!("PCAN-USB {}", n),
        };

        devices.push(InterfaceInfo {
            id: format!("pcan_usb{}", n),
            name: display_name,
            interface_type: "pcan".to_string(),
            available: cond & pcbusb::PCAN_CHANNEL_AVAILABLE != 0,
            condition: Some(if cond & pcbusb::PCAN_CHANNEL_AVAILABLE != 0 {
                "available".to_string()
            } else {
                "occupied".to_string()
            }),
            device_id,
            firmware,
        });
    }
    devices
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_mapping() {
        assert_eq!(handle_from_id("pcan_usb1"), Some(0x51));
        assert_eq!(handle_from_id("pcan_usb8"), Some(0x58));
        assert_eq!(handle_from_id("pcan_usb9"), None);
        assert_eq!(handle_from_id("pcan_usb0"), None);
        assert_eq!(handle_from_id("vcan0"), None);
    }

    #[test]
    fn bitrate_mapping() {
        assert_eq!(
            PcanBitrate::from_bps(500_000).unwrap(),
            PcanBitrate::Baud500K
        );
        assert_eq!(
            PcanBitrate::from_bps(250_000).unwrap(),
            PcanBitrate::Baud250K
        );
        assert_eq!(
            PcanBitrate::from_bps(1_000_000).unwrap(),
            PcanBitrate::Baud1M
        );
        assert!(PcanBitrate::from_bps(123_456).is_err());
    }

    #[test]
    fn status_to_state() {
        assert_eq!(state_from_status(pcbusb::PCAN_ERROR_OK), STATE_ACTIVE);
        assert_eq!(
            state_from_status(pcbusb::PCAN_ERROR_BUSLIGHT),
            STATE_WARNING
        );
        assert_eq!(
            state_from_status(pcbusb::PCAN_ERROR_BUSHEAVY),
            STATE_WARNING
        );
        assert_eq!(
            state_from_status(pcbusb::PCAN_ERROR_BUSPASSIVE),
            STATE_PASSIVE
        );
        assert_eq!(state_from_status(pcbusb::PCAN_ERROR_BUSOFF), STATE_BUSOFF);
    }
}
