mod commands;
mod core;
mod hal;

use commands::*;
use core::channel::ChannelManager;
use core::dbc::DbcDatabase;
use core::trace_logger::TraceLogger;
use core::trace_player::TracePlayer;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{watch, RwLock as TokioRwLock};

/// Application state shared across all Tauri commands
pub struct AppState {
    pub channel_manager: Arc<RwLock<ChannelManager>>,
    /// Tracks active periodic transmit jobs with their cancellation senders
    pub periodic_jobs: Arc<RwLock<HashMap<String, watch::Sender<bool>>>>,
    /// Trace logger for recording CAN messages
    pub trace_logger: Arc<RwLock<Option<TraceLogger>>>,
    /// Trace player for replaying log files (using tokio::RwLock for async compatibility)
    pub trace_player: Arc<TokioRwLock<TracePlayer>>,
    /// DBC databases loaded per channel (channel_id -> DBC database)
    pub dbc_databases: Arc<RwLock<HashMap<String, DbcDatabase>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            channel_manager: Arc::new(RwLock::new(ChannelManager::new())),
            periodic_jobs: Arc::new(RwLock::new(HashMap::new())),
            trace_logger: Arc::new(RwLock::new(None)),
            trace_player: Arc::new(TokioRwLock::new(TracePlayer::new())),
            dbc_databases: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
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
            get_message_info,
            get_all_signals,
            set_advanced_filter,
            save_project,
            load_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

