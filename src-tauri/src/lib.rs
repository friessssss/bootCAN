mod commands;
mod core;
mod hal;

use commands::*;
use core::batcher::FrameBatcher;
use core::channel::ChannelManager;
use core::dbc::DbcDatabase;
use core::message::CanFrame;
use core::trace_logger::TraceLogger;
use core::trace_player::TracePlayer;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::{watch, RwLock as TokioRwLock};

/// A running periodic transmit job.
///
/// `frame` is shared with the transmit task so edits apply on the next tick
/// without restarting the job; `count` tracks frames sent so far.
pub struct PeriodicJob {
    pub cancel: watch::Sender<bool>,
    pub frame: Arc<RwLock<CanFrame>>,
    pub count: Arc<AtomicU64>,
}

/// Application state shared across all Tauri commands
pub struct AppState {
    pub channel_manager: Arc<RwLock<ChannelManager>>,
    /// Active periodic transmit jobs by job id
    pub periodic_jobs: Arc<RwLock<HashMap<String, PeriodicJob>>>,
    /// Trace logger for recording CAN messages
    pub trace_logger: Arc<RwLock<Option<TraceLogger>>>,
    /// Trace player for replaying log files (using tokio::RwLock for async compatibility)
    pub trace_player: Arc<TokioRwLock<TracePlayer>>,
    /// DBC databases loaded per channel (channel_id -> DBC database)
    pub dbc_databases: Arc<RwLock<HashMap<String, DbcDatabase>>>,
    /// Collects all frontend-bound frames; flushed as `can-message-batch`
    pub frame_batcher: FrameBatcher,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            channel_manager: Arc::new(RwLock::new(ChannelManager::new())),
            periodic_jobs: Arc::new(RwLock::new(HashMap::new())),
            trace_logger: Arc::new(RwLock::new(None)),
            trace_player: Arc::new(TokioRwLock::new(TracePlayer::new())),
            dbc_databases: Arc::new(RwLock::new(HashMap::new())),
            frame_batcher: FrameBatcher::new(),
        }
    }
}

/// Emits buffered frames as `can-message-batch` at ~30 Hz (or immediately
/// when the batcher signals an early flush).
fn spawn_batch_flusher(app: tauri::AppHandle, batcher: FrameBatcher) {
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        let interval = std::time::Duration::from_millis(core::batcher::FLUSH_INTERVAL_MS);
        loop {
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = batcher.early_flush_signaled() => {}
            }
            let frames = batcher.drain();
            if !frames.is_empty() {
                if let Err(e) = app.emit("can-message-batch", &frames) {
                    log::error!("Failed to emit can-message-batch: {:?}", e);
                }
            }
        }
    });
}

/// Re-enumerates CAN interfaces every 2 s and emits `interfaces-changed`
/// whenever the set of attached devices changes (hot-plug detection).
fn spawn_hotplug_watcher(app: tauri::AppHandle) {
    use hal::traits::{enumerate_interfaces, InterfaceInfo};
    use tauri::Emitter;

    tauri::async_runtime::spawn(async move {
        let mut last: Option<Vec<InterfaceInfo>> = None;
        loop {
            // Enumeration probes the driver; keep it off the async executor.
            let current = tokio::task::spawn_blocking(enumerate_interfaces).await;
            let Ok(current) = current else { break };

            if last.as_ref() != Some(&current) {
                if last.is_some() {
                    log::info!("CAN interface set changed ({} entries)", current.len());
                }
                let _ = app.emit("interfaces-changed", &current);
                last = Some(current);
            }

            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            use tauri::Manager;
            spawn_hotplug_watcher(app.handle().clone());
            let batcher = app.state::<AppState>().frame_batcher.clone();
            spawn_batch_flusher(app.handle().clone(), batcher);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_interfaces,
            connect,
            connect_channel,
            disconnect,
            disconnect_channel,
            send_message,
            get_bus_stats,
            start_periodic_transmit,
            stop_periodic_transmit,
            update_periodic_transmit,
            get_periodic_tx_counts,
            start_logging,
            stop_logging,
            load_trace,
            get_trace_frames,
            start_playback,
            stop_playback,
            pause_playback,
            resume_playback,
            set_playback_speed,
            get_playback_state,
            load_dbc,
            decode_message,
            decode_messages_batch,
            get_message_info,
            get_message_by_name,
            get_message_names,
            encode_signals,
            get_all_signals,
            set_advanced_filter,
            save_project,
            load_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
