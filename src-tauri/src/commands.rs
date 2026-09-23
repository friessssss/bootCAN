//! Tauri IPC commands for frontend-backend communication

use crate::core::bus_stats::BusStats;
use crate::core::channel::{Channel, ChannelConfig, ChannelState};
use crate::core::dbc::{DbcParser, DecodedSignal, SymParser};
use crate::core::filter::FilterSet;
use crate::core::message::{CanFrame, FramePayload};
use crate::core::trace_logger::{TraceFormat, TraceLogger, TraceLoggerConfig};
use crate::core::trace_player::PlaybackState;
use crate::hal::traits::{enumerate_interfaces, BusState, InterfaceInfo};
use crate::AppState;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Maximum frames drained from a channel per receive-pump tick.
const RX_BATCH_SIZE: usize = 2048;

/// Bus statistics with channel ID for per-channel tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelBusStats {
    pub channel_id: String,
    pub bus_state: BusState,
    #[serde(flatten)]
    pub stats: BusStats,
}

/// Get list of available CAN interfaces
#[tauri::command]
pub async fn get_interfaces() -> Result<Vec<InterfaceInfo>, String> {
    Ok(enumerate_interfaces())
}

/// Shared connect path: connects the channel, then starts its receive pump
/// and statistics loops.
async fn connect_channel_impl(
    state: &State<'_, AppState>,
    app: &AppHandle,
    channel_id: String,
    interface_id: String,
    bitrate: u32,
) -> Result<(), String> {
    let config = ChannelConfig {
        interface_id: interface_id.clone(),
        bitrate,
        listen_only: false,
    };

    let channel = {
        let mut manager = state.channel_manager.write();
        let channel = manager.get_or_create_channel(&channel_id);
        manager.set_active_channel(&channel_id);
        channel
    };

    // Driver initialization can block for tens of milliseconds.
    {
        let channel = channel.clone();
        tokio::task::spawn_blocking(move || channel.write().connect(config))
            .await
            .map_err(|e| e.to_string())??;
    }

    spawn_receive_pump(
        channel.clone(),
        app.clone(),
        channel_id.clone(),
        state.frame_batcher.clone(),
    );
    spawn_stats_loop(channel.clone(), app.clone(), channel_id.clone(), bitrate);

    log::info!(
        "Connected channel {} to {} at {} bps",
        channel_id,
        interface_id,
        bitrate
    );
    Ok(())
}

/// Drains received frames from the channel and pushes them into the frame
/// batcher. Ends when the channel leaves the Connected state or the
/// interface fails.
fn spawn_receive_pump(
    channel: Arc<RwLock<Channel>>,
    app: AppHandle,
    channel_id: String,
    batcher: crate::core::batcher::FrameBatcher,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            interval.tick().await;

            let batch = {
                let mut ch = channel.write();
                if ch.state != ChannelState::Connected {
                    break;
                }
                match ch.receive_batch(RX_BATCH_SIZE) {
                    Ok(frames) => frames,
                    Err(e) => {
                        log::error!("Channel {} receive failed: {}", channel_id, e);
                        let _ = ch.disconnect();
                        let _ = app.emit(
                            "channel-error",
                            serde_json::json!({ "channelId": channel_id, "error": e }),
                        );
                        break;
                    }
                }
            };

            batcher.push_many(batch);
        }

        log::info!("Receive loop ended for channel {}", channel_id);
    });
}

/// Emits `bus-stats` for the channel every 100 ms until it disconnects.
fn spawn_stats_loop(
    channel: Arc<RwLock<Channel>>,
    app: AppHandle,
    channel_id: String,
    bitrate: u32,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        let mut last_bits_total = 0u64;
        let mut last_update_time = std::time::Instant::now();

        loop {
            interval.tick().await;

            let result = {
                let mut ch = channel.write();

                if ch.state != ChannelState::Connected {
                    None
                } else {
                    // Bus load from the observed wire-bit rate
                    let now = std::time::Instant::now();
                    let elapsed = now.duration_since(last_update_time).as_secs_f64();

                    if elapsed > 0.0 {
                        let bits_delta = ch.stats.bits_total.saturating_sub(last_bits_total);
                        let bits_per_second = bits_delta as f64 / elapsed;

                        ch.stats.update_bus_load(bits_per_second, bitrate);

                        last_bits_total = ch.stats.bits_total;
                        last_update_time = now;
                    }

                    Some(ChannelBusStats {
                        channel_id: channel_id.clone(),
                        bus_state: ch.get_bus_state(),
                        stats: ch.stats.clone(),
                    })
                }
            };

            match result {
                Some(stats) => {
                    let _ = app.emit("bus-stats", stats);
                }
                None => break,
            }
        }
    });
}

/// Connect to a CAN interface (legacy - uses interface_id as channel_id)
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    app: AppHandle,
    interface_id: String,
    bitrate: u32,
) -> Result<(), String> {
    connect_channel_impl(&state, &app, interface_id.clone(), interface_id, bitrate).await
}

/// Connect a specific channel by its ID
#[tauri::command]
pub async fn connect_channel(
    state: State<'_, AppState>,
    app: AppHandle,
    channel_id: String,
    interface_id: String,
    bitrate: u32,
) -> Result<(), String> {
    connect_channel_impl(&state, &app, channel_id, interface_id, bitrate).await
}

/// Disconnect from the current CAN interface (legacy)
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let channel = {
        let manager = state.channel_manager.read();
        manager.get_active_channel()
    };

    if let Some(channel) = channel {
        // Disconnecting joins the driver's reader thread; do it off-loop.
        let channel_id = tokio::task::spawn_blocking(move || {
            let mut ch = channel.write();
            let id = ch.id.clone();
            ch.disconnect().map(|_| id)
        })
        .await
        .map_err(|e| e.to_string())??;

        log::info!("Disconnected from {}", channel_id);
    }

    Ok(())
}

/// Disconnect a specific channel by its ID
#[tauri::command]
pub async fn disconnect_channel(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<(), String> {
    let channel = {
        let manager = state.channel_manager.read();
        manager.get_channel(&channel_id)
    };

    if let Some(channel) = channel {
        tokio::task::spawn_blocking(move || channel.write().disconnect())
            .await
            .map_err(|e| e.to_string())??;

        log::info!("Disconnected channel {}", channel_id);
    }

    Ok(())
}

/// Send a CAN message
#[tauri::command]
pub async fn send_message(state: State<'_, AppState>, frame: FramePayload) -> Result<(), String> {
    log::debug!("send_message called with frame ID: 0x{:X}", frame.id);

    let channel = {
        let mut manager = state.channel_manager.write();
        // Use channel from frame if provided, otherwise use active channel
        if let Some(channel_id) = &frame.channel {
            // Get or create the channel if it doesn't exist
            manager.get_or_create_channel(channel_id)
        } else {
            // If no channel specified, try active channel, or create a default one
            // Get the active channel ID first (clone to avoid borrow issues)
            let active_id = manager.get_active_channel_id().cloned();
            if let Some(active_id) = active_id {
                manager.get_or_create_channel(&active_id)
            } else {
                return Err("No channel specified and no active channel".to_string());
            }
        }
    };

    // Create base frame
    let can_frame: CanFrame = frame.into();

    // Sending is non-blocking (queues into the driver), so no offloading needed.
    let sent_frame = {
        let mut ch = channel.write();

        // Get timestamp AFTER acquiring write lock, right before send
        let timestamp = ch.get_timestamp();
        let channel_id = ch.id.clone();

        // Create the frame we'll emit with proper metadata
        let mut tx_frame = can_frame.clone();
        tx_frame.channel = channel_id;
        tx_frame.timestamp = timestamp;
        tx_frame.direction = "tx".to_string();

        ch.send(can_frame)?;
        tx_frame
    };

    log::debug!(
        "Frame sent, batching event with timestamp {}",
        sent_frame.timestamp
    );

    // Queue the sent frame for the frontend
    state.frame_batcher.push(sent_frame);

    Ok(())
}

/// Get current bus statistics
#[tauri::command]
pub async fn get_bus_stats(state: State<'_, AppState>) -> Result<BusStats, String> {
    let channel = {
        let manager = state.channel_manager.read();
        manager.get_active_channel()
    };

    match channel {
        Some(channel) => {
            let ch = channel.read();
            Ok(ch.stats.clone())
        }
        None => Ok(BusStats::default()),
    }
}

/// Start periodic message transmission
#[tauri::command]
pub async fn start_periodic_transmit(
    state: State<'_, AppState>,
    frame: FramePayload,
    interval_ms: u64,
) -> Result<String, String> {
    let job_id = uuid::Uuid::new_v4().to_string();

    let channel = {
        let mut manager = state.channel_manager.write();
        // Use channel from frame if provided, otherwise use active channel
        if let Some(channel_id) = &frame.channel {
            // Get or create the channel if it doesn't exist
            manager.get_or_create_channel(channel_id)
        } else {
            // If no channel specified, try active channel, or create a default one
            // Get the active channel ID first (clone to avoid borrow issues)
            let active_id = manager.get_active_channel_id().cloned();
            if let Some(active_id) = active_id {
                manager.get_or_create_channel(&active_id)
            } else {
                return Err("No channel specified and no active channel".to_string());
            }
        }
    };

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let shared_frame = Arc::new(RwLock::new(CanFrame::from(frame)));
    let count = Arc::new(std::sync::atomic::AtomicU64::new(0));

    {
        let mut jobs = state.periodic_jobs.write();
        jobs.insert(
            job_id.clone(),
            crate::PeriodicJob {
                cancel: cancel_tx,
                frame: shared_frame.clone(),
                count: count.clone(),
            },
        );
    }

    let job_id_clone = job_id.clone();
    let periodic_jobs = state.periodic_jobs.clone();
    let batcher = state.frame_batcher.clone();

    // Spawn periodic transmit task
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(interval_ms));

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let maybe_frame = {
                        let mut ch = channel.write();

                        if ch.state != ChannelState::Connected {
                            break;
                        }

                        // Re-read the shared frame each tick so live edits apply
                        let frame_now = shared_frame.read().clone();

                        // Get timestamp right before send
                        let timestamp = ch.get_timestamp();
                        let channel_id = ch.id.clone();

                        // Create TX frame with proper metadata
                        let mut tx_frame = frame_now.clone();
                        tx_frame.channel = channel_id;
                        tx_frame.timestamp = timestamp;
                        tx_frame.direction = "tx".to_string();

                        match ch.send(frame_now) {
                            Ok(()) => Some(tx_frame),
                            Err(_) => None,
                        }
                    };

                    if let Some(tx_frame) = maybe_frame {
                        count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        batcher.push(tx_frame);
                    }
                }
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow() {
                        log::info!("Periodic transmit job {} cancelled", job_id_clone);
                        break;
                    }
                }
            }
        }

        // Clean up job from tracker
        {
            let mut jobs = periodic_jobs.write();
            jobs.remove(&job_id_clone);
        }

        log::info!("Periodic transmit job {} ended", job_id_clone);
    });

    Ok(job_id)
}

/// Stop periodic message transmission
#[tauri::command]
pub async fn stop_periodic_transmit(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let jobs = state.periodic_jobs.read();
    if let Some(job) = jobs.get(&job_id) {
        let _ = job.cancel.send(true);
        log::info!("Sent cancel signal to job {}", job_id);
    } else {
        log::warn!("Job {} not found", job_id);
    }

    Ok(())
}

/// Update the frame of a running periodic transmit job in place.
/// The new data applies on the job's next tick — no stop/restart glitch.
/// (Changing the interval or target channel still requires a restart.)
#[tauri::command]
pub async fn update_periodic_transmit(
    state: State<'_, AppState>,
    job_id: String,
    frame: FramePayload,
) -> Result<(), String> {
    let jobs = state.periodic_jobs.read();
    let job = jobs
        .get(&job_id)
        .ok_or_else(|| format!("Job {} not found", job_id))?;
    *job.frame.write() = CanFrame::from(frame);
    Ok(())
}

/// Per-job transmit counts for all running periodic jobs.
#[tauri::command]
pub async fn get_periodic_tx_counts(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, u64>, String> {
    let jobs = state.periodic_jobs.read();
    Ok(jobs
        .iter()
        .map(|(id, job)| {
            (
                id.clone(),
                job.count.load(std::sync::atomic::Ordering::Relaxed),
            )
        })
        .collect())
}

/// Set message filter (legacy simple filter)
#[tauri::command]
pub async fn set_filter(
    state: State<'_, AppState>,
    id: Option<u32>,
    mask: Option<u32>,
) -> Result<(), String> {
    let channel = {
        let manager = state.channel_manager.read();
        manager.get_active_channel()
    };

    if let Some(_channel) = channel {
        // TODO: Implement filter setting via HAL
        log::info!("Filter set: id={:?}, mask={:?}", id, mask);
    }

    Ok(())
}

/// Set advanced filter for a channel
#[tauri::command]
pub async fn set_advanced_filter(
    state: State<'_, AppState>,
    channel_id: String,
    filter: FilterSet,
) -> Result<(), String> {
    let channel = {
        let manager = state.channel_manager.read();
        manager.get_channel(&channel_id)
    };

    if let Some(channel) = channel {
        let mut ch = channel.write();
        ch.set_filter(filter);
        log::info!("Advanced filter set for channel {}", channel_id);
    } else {
        return Err(format!("Channel {} not found", channel_id));
    }

    Ok(())
}

/// Clear all received messages (frontend handles this, but we can reset stats)
#[tauri::command]
pub async fn clear_messages(state: State<'_, AppState>) -> Result<(), String> {
    let channel = {
        let manager = state.channel_manager.read();
        manager.get_active_channel()
    };

    if let Some(channel) = channel {
        let mut ch = channel.write();
        ch.stats.reset();
    }

    Ok(())
}

/// Start trace logging
#[tauri::command]
pub async fn start_logging(
    state: State<'_, AppState>,
    file_path: String,
    format: String,
) -> Result<(), String> {
    let format = match format.to_lowercase().as_str() {
        "csv" => TraceFormat::Csv,
        "trc" => TraceFormat::Trc,
        _ => return Err("Invalid format. Use 'csv' or 'trc'".to_string()),
    };

    let config = TraceLoggerConfig {
        format,
        file_path: PathBuf::from(file_path),
        auto_split: false,
        max_file_size_mb: None,
        max_file_duration_sec: None,
    };

    let mut logger = TraceLogger::new(config);
    logger.start().await?;

    // Get sender and hook it up to message events
    if let Some(sender) = logger.get_sender() {
        // Subscribe to channel messages and forward to logger
        let channel = {
            let manager = state.channel_manager.read();
            manager.get_active_channel()
        };

        if let Some(channel) = channel {
            let mut rx = channel.read().subscribe();
            let sender_clone = sender.clone();

            // Forward frames to the logger only; the receive pump already
            // delivers them to the frontend via the frame batcher.
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(frame) => {
                            if sender_clone.send(frame).is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            log::warn!("Trace logger lagged, {} frames skipped", n);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        }
    }

    *state.trace_logger.write() = Some(logger);
    Ok(())
}

/// Stop trace logging
#[tauri::command]
pub async fn stop_logging(state: State<'_, AppState>) -> Result<(), String> {
    let logger_opt = {
        let mut guard = state.trace_logger.write();
        guard.take()
    };
    if let Some(mut logger) = logger_opt {
        logger.stop().await?;
    }
    Ok(())
}

/// Load trace file for playback
#[tauri::command]
pub async fn load_trace(
    state: State<'_, AppState>,
    app: AppHandle,
    file_path: String,
    bus_to_channel_map: Option<std::collections::HashMap<String, String>>,
    channel_name_to_id_map: Option<std::collections::HashMap<String, String>>,
) -> Result<usize, String> {
    // Build bus-to-channel mapping
    // If provided by frontend, use it; otherwise build from DBC databases
    let bus_to_channel = if let Some(map) = bus_to_channel_map {
        log::info!("Using provided bus-to-channel mapping (names): {:?}", map);
        log::info!("Channel name-to-ID mapping: {:?}", channel_name_to_id_map);

        // Convert string keys to u8 and resolve channel names to IDs
        let mut resolved_map = std::collections::HashMap::new();
        for (bus_num_str, channel_name) in map.iter() {
            // Parse bus number from string key
            let bus_num = bus_num_str
                .parse::<u8>()
                .map_err(|e| format!("Invalid bus number '{}': {}", bus_num_str, e))?;

            // If channel names are provided, resolve them to channel IDs
            if let Some(ref name_to_id) = channel_name_to_id_map {
                if let Some(channel_id) = name_to_id.get(channel_name) {
                    resolved_map.insert(bus_num, channel_id.clone());
                    log::info!(
                        "Resolved bus {} -> channel name '{}' -> channel ID '{}'",
                        bus_num,
                        channel_name,
                        channel_id
                    );
                } else {
                    log::warn!(
                        "Channel name '{}' not found in name-to-ID mapping, using name as-is",
                        channel_name
                    );
                    resolved_map.insert(bus_num, channel_name.clone());
                }
            } else {
                // No name-to-ID mapping provided, assume values are already channel IDs
                log::warn!(
                    "No name-to-ID mapping provided, using channel name '{}' as channel ID",
                    channel_name
                );
                resolved_map.insert(bus_num, channel_name.clone());
            }
        }
        log::info!("Final resolved mapping: {:?}", resolved_map);
        Some(resolved_map)
    } else {
        // Build bus-to-channel mapping from DBC database channel IDs
        // This ensures trace frames use the same channel IDs that signals are selected with
        let dbc_databases = state.dbc_databases.read();
        let mut mapping = std::collections::HashMap::new();

        // Use DBC database channel IDs directly (these are what signals are selected with)
        // Sort them to ensure consistent ordering (by channel ID string)
        let mut dbc_channel_ids: Vec<_> = dbc_databases.keys().cloned().collect();
        dbc_channel_ids.sort(); // Sort for consistent ordering

        if !dbc_channel_ids.is_empty() {
            // Map bus number (1-indexed) to DBC channel ID
            // Bus 1 -> first DBC channel, Bus 2 -> second DBC channel, etc.
            for (idx, channel_id) in dbc_channel_ids.iter().enumerate() {
                mapping.insert((idx + 1) as u8, channel_id.clone());
                log::debug!("Mapping bus {} -> channel {}", idx + 1, channel_id);
            }
        } else {
            // Fallback: if no DBC files are loaded, use channel manager channel IDs
            let manager = state.channel_manager.read();
            let mut channel_ids: Vec<_> = manager.get_channel_ids().iter().cloned().collect();
            channel_ids.sort(); // Sort for consistent ordering
            for (idx, channel_id) in channel_ids.iter().enumerate() {
                mapping.insert((idx + 1) as u8, channel_id.clone());
                log::debug!("Mapping bus {} -> channel {} (no DBC)", idx + 1, channel_id);
            }
        }

        log::info!("Auto-generated bus to channel mapping: {:?}", mapping);
        if mapping.is_empty() {
            log::warn!("No channels found for bus-to-channel mapping!");
            None
        } else {
            Some(mapping)
        }
    };

    log::info!(
        "Passing bus-to-channel mapping to trace player: {:?}",
        bus_to_channel
    );

    // Create progress callback to emit events
    let app_clone = app.clone();
    let progress_callback: Option<Box<dyn Fn(usize) + Send + Sync>> =
        Some(Box::new(move |line_num| {
            let _ = app_clone.emit("trace-load-progress", line_num);
        }));

    let count = {
        let mut player = state.trace_player.write().await;
        let result = player
            .load_file(PathBuf::from(file_path), bus_to_channel, progress_callback)
            .await;
        match result {
            Ok(c) => {
                log::info!("Successfully loaded {} frames from trace file", c);
                Ok(c)
            }
            Err(e) => {
                log::error!("Failed to load trace file: {}", e);
                Err(e)
            }
        }
    }?;

    // Emit completion event
    let _ = app.emit("trace-load-complete", count);

    Ok(count)
}

/// Start trace playback
#[tauri::command]
pub async fn start_playback(state: State<'_, AppState>) -> Result<(), String> {
    {
        let mut player = state.trace_player.write().await;
        player.start()?;
    }

    // Start playback loop - frames go to the frontend only, not to hardware
    let player_clone = state.trace_player.clone();
    let batcher = state.frame_batcher.clone();

    tokio::spawn(async move {
        loop {
            let (frame, delay) = {
                let mut player = player_clone.write().await;
                match player.get_next_frame() {
                    Some((f, d)) => (f, d),
                    None => break,
                }
            };

            // Wait for the delay
            tokio::time::sleep(delay).await;

            // The frame already has the correct channel set from bus mapping
            batcher.push(frame);
        }
    });

    Ok(())
}

/// Stop trace playback
#[tauri::command]
pub async fn stop_playback(state: State<'_, AppState>) -> Result<(), String> {
    let mut player = state.trace_player.write().await;
    player.stop();
    Ok(())
}

/// Pause trace playback
#[tauri::command]
pub async fn pause_playback(state: State<'_, AppState>) -> Result<(), String> {
    let mut player = state.trace_player.write().await;
    player.pause();
    Ok(())
}

/// Resume trace playback
#[tauri::command]
pub async fn resume_playback(state: State<'_, AppState>) -> Result<(), String> {
    let mut player = state.trace_player.write().await;
    player.resume();
    Ok(())
}

/// Set playback speed
#[tauri::command]
pub async fn set_playback_speed(state: State<'_, AppState>, speed: f64) -> Result<(), String> {
    let mut player = state.trace_player.write().await;
    player.set_speed(speed);
    Ok(())
}

/// Get playback state
#[tauri::command]
pub async fn get_playback_state(state: State<'_, AppState>) -> Result<String, String> {
    let player = state.trace_player.read().await;
    Ok(match player.get_state() {
        PlaybackState::Stopped => "stopped".to_string(),
        PlaybackState::Playing => "playing".to_string(),
        PlaybackState::Paused => "paused".to_string(),
    })
}

/// Get all frames from loaded trace (for immediate decoding)
#[tauri::command]
pub async fn get_trace_frames(state: State<'_, AppState>) -> Result<Vec<CanFrame>, String> {
    let player = state.trace_player.read().await;
    Ok(player.get_all_frames())
}

/// Load a DBC or SYM file for a channel
#[tauri::command]
pub async fn load_dbc(
    state: State<'_, AppState>,
    channel_id: String,
    file_path: String,
) -> Result<usize, String> {
    let db = if file_path.to_lowercase().ends_with(".sym") {
        SymParser::parse_file(&file_path)?
    } else {
        DbcParser::parse_file(&file_path)?
    };
    let message_count = db.messages.len();

    {
        let mut databases = state.dbc_databases.write();
        databases.insert(channel_id, db);
    }

    Ok(message_count)
}

/// Decode signals from a CAN frame
#[tauri::command]
pub async fn decode_message(
    state: State<'_, AppState>,
    channel_id: String,
    message_id: u32,
    data: Vec<u8>,
) -> Result<Vec<DecodedSignal>, String> {
    let db = {
        let databases = state.dbc_databases.read();
        databases.get(&channel_id).cloned()
    };

    if let Some(db) = db {
        Ok(db.decode_message(message_id, &data))
    } else {
        Ok(vec![])
    }
}

/// Batch decode multiple messages (for performance with large trace files)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeRequest {
    channel_id: String,
    message_id: u32,
    data: Vec<u8>,
}

#[tauri::command]
pub async fn decode_messages_batch(
    state: State<'_, AppState>,
    requests: Vec<DecodeRequest>,
) -> Result<Vec<Vec<DecodedSignal>>, String> {
    // Clone databases to avoid holding the lock during parallel processing
    let databases: std::collections::HashMap<String, crate::core::dbc::DbcDatabase> = {
        let db_guard = state.dbc_databases.read();
        db_guard.clone()
    };

    // Use rayon for parallel processing
    // Rayon automatically uses all available CPU cores
    use rayon::prelude::*;

    let results: Vec<Vec<DecodedSignal>> = requests
        .par_iter()
        .map(|req| {
            if let Some(db) = databases.get(&req.channel_id) {
                db.decode_message(req.message_id, &req.data)
            } else {
                vec![]
            }
        })
        .collect();

    Ok(results)
}

/// Get message information from DBC
#[tauri::command]
pub async fn get_message_info(
    state: State<'_, AppState>,
    channel_id: String,
    message_id: u32,
) -> Result<Option<serde_json::Value>, String> {
    let db = {
        let databases = state.dbc_databases.read();
        databases.get(&channel_id).cloned()
    };

    if let Some(db) = db {
        if let Some(message) = db.get_message(message_id) {
            Ok(Some(
                serde_json::to_value(message).map_err(|e| e.to_string())?,
            ))
        } else {
            Ok(None)
        }
    } else {
        Ok(None)
    }
}

/// Get a message definition by symbolic name, together with the value tables
/// its signals reference (for enum dropdowns in the transmit editor).
#[tauri::command]
pub async fn get_message_by_name(
    state: State<'_, AppState>,
    channel_id: String,
    name: String,
) -> Result<Option<serde_json::Value>, String> {
    let databases = state.dbc_databases.read();
    let Some(db) = databases.get(&channel_id) else {
        return Ok(None);
    };
    // ID ranges are stored once per ID under the same name. Prefer the lowest
    // ID so the transmit editor gets a stable range start.
    let Some(message) = db
        .messages
        .values()
        .filter(|m| m.name == name)
        .min_by_key(|m| m.id)
    else {
        return Ok(None);
    };

    let mut value_tables = serde_json::Map::new();
    for signal in &message.signals {
        if let Some(ref table_name) = signal.value_table {
            if let Some(table) = db.value_tables.get(table_name) {
                let entries: std::collections::HashMap<String, String> = table
                    .values
                    .iter()
                    .map(|(raw, label)| (raw.to_string(), label.clone()))
                    .collect();
                value_tables.insert(
                    table_name.clone(),
                    serde_json::to_value(entries).map_err(|e| e.to_string())?,
                );
            }
        }
    }

    Ok(Some(serde_json::json!({
        "message": message,
        "valueTables": value_tables,
    })))
}

/// Bulk id -> symbolic name map for a channel's loaded symbol file
#[tauri::command]
pub async fn get_message_names(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<std::collections::HashMap<u32, String>, String> {
    let databases = state.dbc_databases.read();
    Ok(databases
        .get(&channel_id)
        .map(|db| {
            db.messages
                .iter()
                .map(|(id, m)| (*id, m.name.clone()))
                .collect()
        })
        .unwrap_or_default())
}

/// Encode physical signal values into message payload bytes.
/// `base` preserves bytes of signals not being edited.
#[tauri::command]
pub async fn encode_signals(
    state: State<'_, AppState>,
    channel_id: String,
    message_id: u32,
    values: std::collections::HashMap<String, f64>,
    base: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let databases = state.dbc_databases.read();
    let db = databases
        .get(&channel_id)
        .ok_or_else(|| format!("No symbol file loaded for channel {}", channel_id))?;
    db.encode_signals(message_id, &values, base)
}

/// Signal information for plotting
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalInfo {
    pub name: String,
    pub unit: String,
    pub value_type: String,
}

/// Message with signals for plotting
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWithSignals {
    pub channel_id: String,
    pub message_id: u32,
    pub message_name: String,
    pub signals: Vec<SignalInfo>,
}

/// Get all available signals from all loaded DBC files
#[tauri::command]
pub async fn get_all_signals(
    state: State<'_, AppState>,
) -> Result<Vec<MessageWithSignals>, String> {
    let databases = {
        let db_map = state.dbc_databases.read();
        db_map.clone()
    };

    let mut result = Vec::new();

    for (channel_id, db) in databases.iter() {
        for (message_id, message) in db.messages.iter() {
            let signals: Vec<SignalInfo> = message
                .signals
                .iter()
                .map(|signal| {
                    let value_type = match signal.value_type {
                        crate::core::dbc::models::ValueType::Unsigned => "unsigned",
                        crate::core::dbc::models::ValueType::Signed => "signed",
                        crate::core::dbc::models::ValueType::Float => "float",
                        crate::core::dbc::models::ValueType::Double => "double",
                    };
                    SignalInfo {
                        name: signal.name.clone(),
                        unit: signal.unit.clone(),
                        value_type: value_type.to_string(),
                    }
                })
                .collect();

            if !signals.is_empty() {
                result.push(MessageWithSignals {
                    channel_id: channel_id.clone(),
                    message_id: *message_id,
                    message_name: message.name.clone(),
                    signals,
                });
            }
        }
    }

    Ok(result)
}

/// Project file structures (version 2.0)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectNet {
    pub id: String,
    pub name: String,
    pub bitrate: u32,
    /// Device binding is kept even when the device is unplugged; the UI shows
    /// the net as unassigned/unplugged rather than losing the association.
    pub assigned_device_id: Option<String>,
    pub symbol_file_path: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFilter {
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTransmitRow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub comment: String,
    pub net_id: Option<String>,
    pub can_id: u32,
    pub is_extended: bool,
    pub is_remote: bool,
    pub dlc: u8,
    pub data: Vec<u8>,
    /// Cycle time in ms; 0 = manual-only.
    pub cycle_ms: u64,
    #[serde(default)]
    pub signal_values: Option<std::collections::HashMap<String, f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub version: String,
    pub nets: Vec<ProjectNet>,
    pub filters: Vec<ProjectFilter>,
    pub transmit_rows: Vec<ProjectTransmitRow>,
}

/// Version 1.0 shapes, accepted on load and migrated to 2.0.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectChannelV1 {
    id: String,
    name: String,
    interface_id: Option<String>,
    bitrate: u32,
    dbc_file: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTransmitJobV1 {
    id: String,
    frame: FramePayload,
    interval_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFileV1 {
    #[allow(dead_code)]
    version: String,
    channels: Vec<ProjectChannelV1>,
    #[serde(default)]
    filters: Vec<ProjectFilter>,
    #[serde(default)]
    transmit_jobs: Vec<ProjectTransmitJobV1>,
}

fn migrate_project_v1(v1: ProjectFileV1) -> ProjectFile {
    ProjectFile {
        version: "2.0".to_string(),
        nets: v1
            .channels
            .into_iter()
            .map(|ch| ProjectNet {
                id: ch.id,
                name: ch.name,
                bitrate: ch.bitrate,
                assigned_device_id: ch.interface_id,
                symbol_file_path: ch.dbc_file,
                comment: None,
            })
            .collect(),
        filters: v1.filters,
        transmit_rows: v1
            .transmit_jobs
            .into_iter()
            .map(|job| ProjectTransmitRow {
                id: job.id,
                name: format!("0x{:X}", job.frame.id),
                comment: String::new(),
                net_id: job.frame.channel.clone(),
                can_id: job.frame.id,
                is_extended: job.frame.is_extended,
                is_remote: job.frame.is_remote,
                dlc: job.frame.dlc,
                data: job.frame.data,
                cycle_ms: job.interval_ms,
                signal_values: None,
            })
            .collect(),
    }
}

/// Save project to file
#[tauri::command]
pub async fn save_project(
    file_path: String,
    nets: Vec<ProjectNet>,
    filters: Vec<ProjectFilter>,
    transmit_rows: Vec<ProjectTransmitRow>,
) -> Result<(), String> {
    let project = ProjectFile {
        version: "2.0".to_string(),
        nets,
        filters,
        transmit_rows,
    };

    let json = serde_json::to_string_pretty(&project)
        .map_err(|e| format!("Failed to serialize project: {}", e))?;

    fs::write(&file_path, json).map_err(|e| format!("Failed to write project file: {}", e))?;

    log::info!("Project saved to {}", file_path);
    Ok(())
}

/// Load project from file (accepts 1.0 and 2.0 formats)
#[tauri::command]
pub async fn load_project(file_path: String) -> Result<ProjectFile, String> {
    let contents = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read project file: {}", e))?;

    let raw: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse project file: {}", e))?;
    let version = raw.get("version").and_then(|v| v.as_str()).unwrap_or("1.0");

    let project: ProjectFile = if version.starts_with("2") {
        serde_json::from_value(raw)
            .map_err(|e| format!("Failed to parse project file (v2): {}", e))?
    } else {
        let v1: ProjectFileV1 = serde_json::from_value(raw)
            .map_err(|e| format!("Failed to parse project file (v1): {}", e))?;
        log::info!("Migrating project file from version 1.0 to 2.0");
        migrate_project_v1(v1)
    };

    // Validate symbol file paths still exist (device bindings are kept as-is;
    // the UI shows unplugged devices distinctly).
    let validated_nets: Vec<ProjectNet> = project
        .nets
        .into_iter()
        .map(|mut net| {
            if let Some(ref path) = net.symbol_file_path {
                if !PathBuf::from(path).exists() {
                    log::warn!("Symbol file {} not found, clearing", path);
                    net.symbol_file_path = None;
                }
            }
            net
        })
        .collect();

    let validated_project = ProjectFile {
        version: "2.0".to_string(),
        nets: validated_nets,
        filters: project.filters,
        transmit_rows: project.transmit_rows,
    };

    log::info!("Project loaded from {}", file_path);
    Ok(validated_project)
}
