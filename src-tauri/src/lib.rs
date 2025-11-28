mod commands;
mod core;
mod hal;

use commands::*;
use core::channel::ChannelManager;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::watch;

/// Application state shared across all Tauri commands
pub struct AppState {
    pub channel_manager: Arc<RwLock<ChannelManager>>,
    /// Tracks active periodic transmit jobs with their cancellation senders
    pub periodic_jobs: Arc<RwLock<HashMap<String, watch::Sender<bool>>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            channel_manager: Arc::new(RwLock::new(ChannelManager::new())),
            periodic_jobs: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_interfaces,
            connect,
            disconnect,
            send_message,
            get_bus_stats,
            start_periodic_transmit,
            stop_periodic_transmit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

