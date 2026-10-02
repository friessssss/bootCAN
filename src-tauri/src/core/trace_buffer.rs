//! Background trace buffer.
//!
//! Recording is independent of which window is on screen and of display
//! pause. Frames are kept until the user clears them or starts a new trace,
//! then exported as PEAK TRC or MCAP.

use crate::core::message::CanFrame;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Hard cap so a long capture cannot grow without bound.
/// About two million classic frames is on the order of a few hundred MB.
pub const MAX_TRACE_FRAMES: usize = 2_000_000;

/// How many frames the on-screen trace keeps. The buffer itself is larger.
pub const TRACE_UI_WINDOW: usize = 20_000;

/// One captured frame. `offset_ns` is nanoseconds since the trace started.
#[derive(Debug, Clone)]
pub struct CapturedFrame {
    pub offset_ns: u64,
    pub id: u32,
    pub is_extended: bool,
    pub is_remote: bool,
    pub dlc: u8,
    pub data: Vec<u8>,
    pub channel: String,
    pub is_tx: bool,
}

impl CapturedFrame {
    pub fn to_can_frame(&self) -> CanFrame {
        CanFrame {
            id: self.id,
            is_extended: self.is_extended,
            is_remote: self.is_remote,
            dlc: self.dlc,
            data: self.data.clone(),
            timestamp: self.offset_ns as f64 / 1e9,
            channel: self.channel.clone(),
            direction: if self.is_tx {
                "tx".to_string()
            } else {
                "rx".to_string()
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceStatus {
    pub recording: bool,
    pub frame_count: u64,
    pub truncated: bool,
    pub epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceWindow {
    pub recording: bool,
    pub frame_count: u64,
    pub truncated: bool,
    pub epoch: u64,
    pub frames: Vec<CanFrame>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceUiBatch {
    pub epoch: u64,
    pub start_index: u64,
    pub frames: Vec<CanFrame>,
}

struct Inner {
    recording: bool,
    truncated: bool,
    epoch: u64,
    start_instant: Option<Instant>,
    start_epoch_ns: u64,
    /// Channel timestamp (seconds since that net connected) at trace start.
    /// Offset = frame.timestamp - base, so hardware time is preserved.
    channel_base: HashMap<String, f64>,
    frames: Vec<CapturedFrame>,
    ui_cursor: usize,
    logged_full: bool,
}

impl Inner {
    fn status(&self) -> TraceStatus {
        TraceStatus {
            recording: self.recording,
            frame_count: self.frames.len() as u64,
            truncated: self.truncated,
            epoch: self.epoch,
        }
    }
}

/// Shared recorder attached to every connected net while a trace is running.
#[derive(Clone)]
pub struct TraceRecorder {
    /// Fast path so idle traffic does not take the buffer lock.
    recording: Arc<AtomicBool>,
    inner: Arc<parking_lot::Mutex<Inner>>,
}

impl Default for TraceRecorder {
    fn default() -> Self {
        Self::new()
    }
}

impl TraceRecorder {
    pub fn new() -> Self {
        Self {
            recording: Arc::new(AtomicBool::new(false)),
            inner: Arc::new(parking_lot::Mutex::new(Inner {
                recording: false,
                truncated: false,
                epoch: 0,
                start_instant: None,
                start_epoch_ns: 0,
                channel_base: HashMap::new(),
                frames: Vec::new(),
                ui_cursor: 0,
                logged_full: false,
            })),
        }
    }

    pub fn is_recording(&self) -> bool {
        self.recording.load(Ordering::Acquire)
    }

    /// Begin a new trace. Previous frames are dropped.
    /// `bases` maps channel id → that channel's timestamp at this instant.
    pub fn start(&self, bases: HashMap<String, f64>) -> TraceStatus {
        let mut g = self.inner.lock();
        g.epoch = g.epoch.wrapping_add(1);
        g.recording = true;
        g.truncated = false;
        g.logged_full = false;
        g.start_instant = Some(Instant::now());
        g.start_epoch_ns = system_now_ns();
        g.channel_base = bases;
        g.frames.clear();
        g.ui_cursor = 0;
        let status = g.status();
        drop(g);
        self.recording.store(true, Ordering::Release);
        status
    }

    /// Stop appending. Captured frames stay available for export.
    pub fn stop(&self) -> TraceStatus {
        let mut g = self.inner.lock();
        g.recording = false;
        let status = g.status();
        drop(g);
        self.recording.store(false, Ordering::Release);
        status
    }

    /// Drop captured frames. An in-progress trace keeps recording from zero.
    pub fn clear(&self, bases: HashMap<String, f64>) -> TraceStatus {
        let mut g = self.inner.lock();
        g.epoch = g.epoch.wrapping_add(1);
        g.truncated = false;
        g.logged_full = false;
        g.frames.clear();
        g.ui_cursor = 0;
        if g.recording {
            g.start_instant = Some(Instant::now());
            g.start_epoch_ns = system_now_ns();
            g.channel_base = bases;
        } else {
            g.start_instant = None;
            g.start_epoch_ns = 0;
            g.channel_base.clear();
        }
        g.status()
    }

    /// A net connected (or reconnected) while a trace is already running.
    pub fn note_channel(&self, channel_id: &str, timestamp_now: f64) {
        if !self.is_recording() {
            return;
        }
        let mut g = self.inner.lock();
        if !g.recording {
            return;
        }
        let elapsed = g
            .start_instant
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        g.channel_base
            .insert(channel_id.to_string(), timestamp_now - elapsed);
    }

    /// Record one frame. Safe to call when not recording; it returns immediately.
    pub fn record(&self, frame: &CanFrame) {
        if !self.recording.load(Ordering::Acquire) {
            return;
        }
        let mut g = self.inner.lock();
        if !g.recording {
            return;
        }
        if g.frames.len() >= MAX_TRACE_FRAMES {
            if !g.logged_full {
                log::warn!(
                    "Trace buffer full ({} frames); further frames are not retained",
                    MAX_TRACE_FRAMES
                );
                g.logged_full = true;
            }
            g.truncated = true;
            return;
        }

        let base = g.channel_base.get(&frame.channel).copied().unwrap_or(0.0);
        let host_elapsed = g
            .start_instant
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let offset = frame_offset(frame.timestamp - base, host_elapsed);
        let offset_ns = (offset * 1e9).round() as u64;
        let n = if frame.is_remote {
            0
        } else {
            (frame.dlc as usize).min(frame.data.len()).min(64)
        };
        g.frames.push(CapturedFrame {
            offset_ns,
            id: frame.id,
            is_extended: frame.is_extended,
            is_remote: frame.is_remote,
            dlc: frame.dlc,
            data: frame.data[..n].to_vec(),
            channel: frame.channel.clone(),
            is_tx: frame.direction.eq_ignore_ascii_case("tx"),
        });
    }

    pub fn status(&self) -> TraceStatus {
        self.inner.lock().status()
    }

    /// Copy of the retained frames for export. Does not clear the buffer.
    pub fn snapshot(&self) -> (u64, Vec<CapturedFrame>) {
        let g = self.inner.lock();
        (g.start_epoch_ns, g.frames.clone())
    }

    /// Frames newly available for the on-screen trace.
    ///
    /// If the UI has fallen behind, the cursor jumps toward the tail so the
    /// view stays on recent traffic instead of replaying the whole buffer.
    pub fn take_ui_batch(&self, max_frames: usize) -> TraceUiBatch {
        let mut g = self.inner.lock();
        let len = g.frames.len();
        if g.ui_cursor > len {
            g.ui_cursor = len;
        }
        if len.saturating_sub(g.ui_cursor) > TRACE_UI_WINDOW {
            g.ui_cursor = len - TRACE_UI_WINDOW;
        }
        let start = g.ui_cursor;
        let end = (start + max_frames).min(len);
        let frames = g.frames[start..end]
            .iter()
            .map(CapturedFrame::to_can_frame)
            .collect();
        g.ui_cursor = end;
        TraceUiBatch {
            epoch: g.epoch,
            start_index: start as u64,
            frames,
        }
    }

    /// Last `limit` frames, and mark them as already delivered to the UI.
    pub fn window(&self, limit: usize) -> TraceWindow {
        let mut g = self.inner.lock();
        let len = g.frames.len();
        g.ui_cursor = len;
        let start = len.saturating_sub(limit);
        let frames = g.frames[start..]
            .iter()
            .map(CapturedFrame::to_can_frame)
            .collect();
        TraceWindow {
            recording: g.recording,
            frame_count: len as u64,
            truncated: g.truncated,
            epoch: g.epoch,
            frames,
        }
    }
}

/// How far a net's own clock may disagree with host time before it is ignored.
const CHANNEL_CLOCK_TOLERANCE_SECS: f64 = 2.0;

/// Trace offset (seconds) for a frame whose channel clock says `channel_delta`
/// since trace start, recorded `host_elapsed` seconds after trace start.
///
/// The channel clock is preferred (driver/hardware precision). If it is
/// clearly wrong — a net whose clock stalled or restarted would otherwise put
/// every frame at 0 — host receive time is used instead.
fn frame_offset(channel_delta: f64, host_elapsed: f64) -> f64 {
    let off_by = channel_delta - host_elapsed;
    if host_elapsed > CHANNEL_CLOCK_TOLERANCE_SECS && off_by.abs() > CHANNEL_CLOCK_TOLERANCE_SECS {
        host_elapsed
    } else {
        channel_delta.max(0.0)
    }
}

pub fn system_now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: u32, timestamp: f64, channel: &str, direction: &str) -> CanFrame {
        CanFrame {
            id,
            is_extended: false,
            is_remote: false,
            dlc: 1,
            data: vec![0xAB],
            timestamp,
            channel: channel.to_string(),
            direction: direction.to_string(),
        }
    }

    #[test]
    fn records_only_while_running_and_keeps_frames_after_stop() {
        let rec = TraceRecorder::new();
        rec.record(&frame(1, 0.0, "a", "rx"));
        assert_eq!(rec.status().frame_count, 0);

        let mut bases = HashMap::new();
        bases.insert("a".to_string(), 10.0);
        rec.start(bases);
        rec.record(&frame(0x123, 10.25, "a", "tx"));
        rec.record(&frame(0x10, 9.0, "a", "rx")); // before the base, clamps to 0
        rec.stop();
        rec.record(&frame(0x99, 12.0, "a", "rx"));

        let (epoch, frames) = rec.snapshot();
        assert!(epoch > 0);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].id, 0x123);
        assert!(frames[0].is_tx);
        assert_eq!(frames[0].offset_ns, 250_000_000);
        assert_eq!(frames[1].offset_ns, 0);
        assert!(!rec.status().recording);
        assert_eq!(rec.status().frame_count, 2);
    }

    #[test]
    fn frame_offset_falls_back_to_host_time_when_channel_clock_is_wrong() {
        // Normal: channel clock wins, small receive latency is ignored.
        assert_eq!(frame_offset(12.345, 12.350), 12.345);
        // Frames queued before the trace started clamp to zero.
        assert_eq!(frame_offset(-0.5, 0.01), 0.0);
        // Stalled/restarted channel clock: frame would collapse onto 0.
        assert_eq!(frame_offset(-40.0, 120.0), 120.0);
        assert_eq!(frame_offset(0.0, 290.7), 290.7);
        // Channel clock running far ahead of the host is equally implausible.
        assert_eq!(frame_offset(500.0, 10.0), 10.0);
    }

    #[test]
    fn clear_drops_frames_and_bumps_epoch() {
        let rec = TraceRecorder::new();
        rec.start(HashMap::new());
        rec.record(&frame(1, 0.0, "a", "rx"));
        let epoch = rec.status().epoch;
        let cleared = rec.clear(HashMap::new());
        assert_eq!(cleared.frame_count, 0);
        assert_ne!(cleared.epoch, epoch);
        assert!(cleared.recording);
    }
}
