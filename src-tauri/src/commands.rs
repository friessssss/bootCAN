//! Tauri IPC commands for frontend-backend communication

use crate::core::bus_stats::BusStats;
use crate::core::channel::{ChannelConfig, ChannelState};
use crate::core::message::{CanFrame, FramePayload};
use crate::core::trace_logger::{TraceLogger, TraceLoggerConfig, TraceFormat};
use crate::core::trace_player::PlaybackState;
use crate::core::dbc::{DbcParser, SymParser, DecodedSignal};
use crate::core::filter::FilterSet;
use crate::hal::traits::{enumerate_interfaces, InterfaceInfo};
use crate::AppState;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use std::time::Duration;

/// Get list of available CAN interfaces
#[tauri::command]
pub async fn get_interfaces() -> Result<Vec<InterfaceInfo>, String> {
    Ok(enumerate_interfaces())
}

/// Connect to a CAN interface (legacy - uses interface_id as channel_id)
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    app: AppHandle,
    interface_id: String,
    bitrate: u32,
) -> Result<(), String> {
    let config = ChannelConfig {
        interface_id: interface_id.clone(),
        bitrate,
        listen_only: false,
    };

    // Get or create the channel and store a clone
    let channel = {
        let mut manager = state.channel_manager.write();
        let channel = manager.get_or_create_channel(&interface_id);
        manager.set_active_channel(&interface_id);
        channel
    };

    // Connect the channel
    {
        let mut ch = channel.write();
        let connect_result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(ch.connect(config))
        });
        connect_result?;
    }

    // Start the receive loop
    let channel_clone = channel.clone();
    let app_clone = app.clone();
    let interface_id_clone = interface_id.clone();

    // Spawn receive loop using spawn_blocking to avoid Send issues
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(1));
        
        loop {
            interval.tick().await;
            
            // Check connection status and receive in a synchronous block
            let result = tokio::task::spawn_blocking({
                let channel = channel_clone.clone();
                let app = app_clone.clone();
                move || {
                    let mut ch = channel.write();
                    // Use the public receive method
                    let receive_result = tokio::runtime::Handle::current().block_on(ch.receive());
                    match receive_result {
                        Ok(Some(frame)) => {
                            // Frame was received and passed filter - emit to frontend
                            if let Err(e) = app.emit("can-message", &frame) {
                                log::error!("Failed to emit can-message event: {:?}", e);
                            }
                        }
                        Ok(None) => {
                            // No frame available or filtered out - continue
                        }
                        Err(e) => {
                            log::error!("Receive error: {}", e);
                        }
                    }
                    Ok::<(), String>(())
                }
            }).await;
            
            if let Err(e) = result {
                log::error!("Error in receive loop: {:?}", e);
                break;
            }
        }
    });

    Ok(())
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
    let config = ChannelConfig {
        interface_id: interface_id.clone(),
        bitrate,
        listen_only: false,
    };

    // Get or create the channel with the specified channel_id
    let channel = {
        let mut manager = state.channel_manager.write();
        let channel = manager.get_or_create_channel(&channel_id);
        manager.set_active_channel(&channel_id);
        channel
    };

    // Connect - acquire lock, connect, release immediately
    {
        let mut ch = channel.write();
        // For non-async connect, we need to block on the future
        // Since virtual CAN is synchronous, this should work
        let connect_result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(ch.connect(config))
        });
        connect_result?;
    }

    // Start the receive loop
    let channel_clone = channel.clone();
    let app_clone = app.clone();
    let channel_id_clone = channel_id.clone();

    // Spawn receive loop using spawn_blocking to avoid Send issues
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(1));
        
        loop {
            interval.tick().await;
            
            // Check connection status and receive in a synchronous block
            let result = tokio::task::spawn_blocking({
                let channel = channel_clone.clone();
                let app = app_clone.clone();
                move || {
                    let mut ch = channel.write();
                    
                    // Check if still connected
                    if ch.state != ChannelState::Connected {
                        return Ok::<bool, String>(false);
                    }
                    
                    // Use the public receive method
                    let rx_result = tokio::runtime::Handle::current()
                        .block_on(ch.receive());
                    
                    match rx_result {
                        Ok(Some(frame)) => {
                            // Frame received and passed filter - emit to frontend
                            if let Err(e) = app.emit("can-message", &frame) {
                                log::error!("Failed to emit can-message event: {:?}", e);
                            }
                            Ok::<bool, String>(true)
                        }
                        Ok(None) => {
                            // No frame available or filtered out - continue
                            Ok::<bool, String>(true)
                        }
                        Err(e) => {
                            log::error!("Receive error: {}", e);
                            Ok::<bool, String>(true)
                        }
                    }
                }
            }).await;
            
            match result {
                Ok(Ok(should_continue)) => {
                    if !should_continue {
                        break;
                    }
                }
                Ok(Err(e)) => {
                    log::error!("Receive error: {}", e);
                }
                Err(e) => {
                    log::error!("Task error: {:?}", e);
                    break;
                }
            }
        }
        
        log::info!("Receive loop ended for channel {}", channel_id_clone);
    });

    log::info!("Connected channel {} to {} at {} bps", channel_id, interface_id, bitrate);
    
    // Start statistics update loop
    let channel_stats = channel.clone();
    let app_stats = app.clone();
    
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        
        loop {
            interval.tick().await;
            
            let result = {
                let ch = channel_stats.read();
                
                if ch.state != ChannelState::Connected {
                    None
                } else {
                    Some(ch.stats.clone())
                }
            };
            
            match result {
                Some(stats) => {
                    let _ = app_stats.emit("bus-stats", stats);
                }
                None => break,
            }
        }
    });

    log::info!("Connected to {} at {} bps", interface_id, bitrate);
    Ok(())
}

/// Disconnect from the current CAN interface (legacy)
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let channel = {
        let manager = state.channel_manager.read();
        manager.get_active_channel()
    };

    if let Some(channel) = channel {
        let channel_id = {
            let ch = channel.read();
            ch.id.clone()
        };
        
        // Disconnect in a blocking context
        tokio::task::spawn_blocking({
            let channel = channel.clone();
            move || {
                let mut ch = channel.write();
                tokio::runtime::Handle::current().block_on(ch.disconnect())
            }
        }).await.map_err(|e| e.to_string())??;
        
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
        // Disconnect in a blocking context
        tokio::task::spawn_blocking({
            let channel = channel.clone();
            move || {
                let mut ch = channel.write();
                tokio::runtime::Handle::current().block_on(ch.disconnect())
            }
        }).await.map_err(|e| e.to_string())??;
        
        log::info!("Disconnected channel {}", channel_id);
    }

    Ok(())
}

/// Send a CAN message
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    app: AppHandle,
    frame: FramePayload,
) -> Result<(), String> {
    log::info!("send_message called with frame ID: 0x{:X}", frame.id);
    
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

    // Send in a blocking context and get the frame with proper timestamp
    let sent_frame = tokio::task::spawn_blocking({
        let channel = channel.clone();
        let frame = can_frame.clone();
        move || {
            let mut ch = channel.write();
            
            // Get timestamp AFTER acquiring write lock, right before send
            let timestamp = ch.get_timestamp();
            let channel_id = ch.id.clone();
            
            // Create the frame we'll emit with proper metadata
            let mut tx_frame = frame.clone();
            tx_frame.channel = channel_id;
            tx_frame.timestamp = timestamp;
            tx_frame.direction = "tx".to_string();
            
            // Send the frame
            let result = tokio::runtime::Handle::current().block_on(ch.send(frame));
            
            result.map(|_| tx_frame)
        }
    }).await.map_err(|e| e.to_string())??;

    log::info!("Frame sent successfully, emitting event with timestamp {}", sent_frame.timestamp);

    // Emit the sent frame to the frontend
    if let Err(e) = app.emit("can-message", &sent_frame) {
        log::error!("Failed to emit can-message event: {:?}", e);
    }

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
    app: AppHandle,
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

    // Create cancellation channel
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    
    // Store the cancellation sender
    {
        let mut jobs = state.periodic_jobs.write();
        jobs.insert(job_id.clone(), cancel_tx);
    }

    let can_frame: CanFrame = frame.into();
    let job_id_clone = job_id.clone();
    let periodic_jobs = state.periodic_jobs.clone();

    // Spawn periodic transmit task
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(interval_ms));
        
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let result = tokio::task::spawn_blocking({
                        let channel = channel.clone();
                        let frame = can_frame.clone();
                        move || {
                            let mut ch = channel.write();
                            
                            if ch.state != ChannelState::Connected {
                                return (false, None);
                            }
                            
                            // Get timestamp right before send
                            let timestamp = ch.get_timestamp();
                            let channel_id = ch.id.clone();
                            
                            // Create TX frame with proper metadata
                            let mut tx_frame = frame.clone();
                            tx_frame.channel = channel_id;
                            tx_frame.timestamp = timestamp;
                            tx_frame.direction = "tx".to_string();
                            
                            let send_result = tokio::runtime::Handle::current()
                                .block_on(ch.send(frame));
                            
                            match send_result {
                                Ok(()) => (true, Some(tx_frame)),
                                Err(_) => (true, None),
                            }
                        }
                    }).await;
                    
                    match result {
                        Ok((should_continue, maybe_frame)) => {
                            if !should_continue {
                                break;
                            }
                            if let Some(tx_frame) = maybe_frame {
                                let _ = app.emit("can-message", tx_frame);
                            }
                        }
                        Err(_) => break,
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
    let cancel_tx = {
        let jobs = state.periodic_jobs.read();
        jobs.get(&job_id).cloned()
    };
    
    if let Some(tx) = cancel_tx {
        let _ = tx.send(true);
        log::info!("Sent cancel signal to job {}", job_id);
    } else {
        log::warn!("Job {} not found", job_id);
    }
    
    Ok(())
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
    app: AppHandle,
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
            let app_clone = app.clone();

            tokio::spawn(async move {
                while let Ok(frame) = rx.recv().await {
                    // Send to logger
                    if sender_clone.send(frame.clone()).is_err() {
                        break;
                    }
                    // Also emit to frontend
                    let _ = app_clone.emit("can-message", frame);
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
    file_path: String,
) -> Result<usize, String> {
    let count = {
        let mut player = state.trace_player.write().await;
        player.load_file(PathBuf::from(file_path)).await?
    };
    Ok(count)
}

/// Start trace playback
#[tauri::command]
pub async fn start_playback(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    {
        let mut player = state.trace_player.write().await;
        player.start()?;
    }

    // Get active channel for sending
    let channel = {
        let manager = state.channel_manager.read();
        manager.get_active_channel()
    };

    if let Some(channel) = channel {
        let channel_clone = channel.clone();
        let player_clone = state.trace_player.clone();
        let app_clone = app.clone();

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

                // Send frame
                let frame_to_send = frame.clone();
                let send_result = tokio::task::spawn_blocking({
                    let channel = channel_clone.clone();
                    move || {
                        let mut ch = channel.write();
                        if ch.state == ChannelState::Connected {
                            tokio::runtime::Handle::current().block_on(ch.send(frame_to_send))
                        } else {
                            Ok(())
                        }
                    }
                }).await;

                if let Err(e) = send_result {
                    log::error!("Failed to send playback frame: {}", e);
                } else if let Err(e) = send_result.unwrap() {
                    log::error!("Failed to send playback frame: {}", e);
                }

                // Emit to frontend
                let _ = app_clone.emit("can-message", frame);
            }
        });
    }

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
pub async fn set_playback_speed(
    state: State<'_, AppState>,
    speed: f64,
) -> Result<(), String> {
    let mut player = state.trace_player.write().await;
    player.set_speed(speed);
    Ok(())
}

/// Get playback state
#[tauri::command]
pub async fn get_playback_state(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let player = state.trace_player.read().await;
    Ok(match player.get_state() {
        PlaybackState::Stopped => "stopped".to_string(),
        PlaybackState::Playing => "playing".to_string(),
        PlaybackState::Paused => "paused".to_string(),
    })
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
            Ok(Some(serde_json::to_value(message).map_err(|e| e.to_string())?))
        } else {
            Ok(None)
        }
    } else {
        Ok(None)
    }
}
