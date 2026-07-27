//! Frame batching for frontend IPC.
//!
//! Every frame destined for the frontend (received, transmitted, or played
//! back) is pushed into one app-level [`FrameBatcher`]; a single flusher task
//! emits the accumulated frames as a `can-message-batch` event at ~30 Hz.
//! This bounds IPC event rate regardless of bus load.

use crate::core::message::CanFrame;
use parking_lot::Mutex;
use std::sync::Arc;
use tokio::sync::Notify;

/// Buffer size that triggers an early flush instead of waiting for the tick.
const EARLY_FLUSH_THRESHOLD: usize = 4096;

/// Flush interval (~30 Hz).
pub const FLUSH_INTERVAL_MS: u64 = 33;

#[derive(Clone)]
pub struct FrameBatcher {
    buf: Arc<Mutex<Vec<CanFrame>>>,
    notify: Arc<Notify>,
}

impl FrameBatcher {
    pub fn new() -> Self {
        Self {
            buf: Arc::new(Mutex::new(Vec::new())),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn push(&self, frame: CanFrame) {
        let len = {
            let mut buf = self.buf.lock();
            buf.push(frame);
            buf.len()
        };
        if len >= EARLY_FLUSH_THRESHOLD {
            self.notify.notify_one();
        }
    }

    pub fn push_many(&self, frames: Vec<CanFrame>) {
        if frames.is_empty() {
            return;
        }
        let len = {
            let mut buf = self.buf.lock();
            buf.extend(frames);
            buf.len()
        };
        if len >= EARLY_FLUSH_THRESHOLD {
            self.notify.notify_one();
        }
    }

    /// Take all buffered frames.
    pub fn drain(&self) -> Vec<CanFrame> {
        std::mem::take(&mut *self.buf.lock())
    }

    /// Resolves on the next early-flush signal.
    pub async fn early_flush_signaled(&self) {
        self.notify.notified().await;
    }
}

impl Default for FrameBatcher {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_returns_pushed_frames_in_order() {
        let batcher = FrameBatcher::new();
        batcher.push(CanFrame::new(0x100, &[1]));
        batcher.push_many(vec![CanFrame::new(0x200, &[2]), CanFrame::new(0x300, &[3])]);

        let drained = batcher.drain();
        assert_eq!(drained.len(), 3);
        assert_eq!(drained[0].id, 0x100);
        assert_eq!(drained[2].id, 0x300);
        assert!(batcher.drain().is_empty());
    }

    #[tokio::test]
    async fn early_flush_fires_at_threshold() {
        let batcher = FrameBatcher::new();
        let frames: Vec<CanFrame> = (0..EARLY_FLUSH_THRESHOLD)
            .map(|i| CanFrame::new(i as u32 & 0x7FF, &[]))
            .collect();
        batcher.push_many(frames);

        // Must resolve promptly because the threshold notification fired.
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            batcher.early_flush_signaled(),
        )
        .await
        .expect("early flush was not signaled");
    }
}
