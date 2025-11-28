//! Tauri IPC commands for frontend-backend communication

use crate::core::bus_stats::BusStats;
use crate::core::channel::{ChannelConfig, ChannelState};
use crate::core::message::{CanFrame, FramePayload};
use crate::hal::traits::{enumerate_interfaces, InterfaceInfo};
use crate::AppState;
use tauri::{AppHandle, Emitter, State};
use std::time::Duration;

/// Get list of available CAN interfaces
#[tauri::command]
pub async fn get_interfaces() -> Result<Vec<InterfaceInfo>, String> {
    Ok(enumerate_interfaces())
}

/// Connect to a CAN interface
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
    let interface_id_clone = interface_id.clone();

    // Spawn receive loop using spawn_blocking to avoid Send issues
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(1));
        
        loop {
            interval.tick().await;
            
            // Check connection status and receive in a synchronous block
            let result = tokio::task::spawn_blocking({
                let channel = channel_clone.clone();
                move || {
                    let mut ch = channel.write();
                    
                    // Check if still connected
                    if ch.state != ChannelState::Connected {
                        return (false, None);
                    }
                    
                    // Try to receive synchronously (virtual CAN is sync anyway)
                    let rx_result = tokio::runtime::Handle::current()
                        .block_on(ch.receive());
                    
                    match rx_result {
                        Ok(frame) => (true, frame),
                        Err(e) => {
                            log::error!("Receive error: {}", e);
                            (true, None)
                        }
                    }
                }
            }).await;
            
            match result {
                Ok((should_continue, frame)) => {
                    if !should_continue {
                        break;
                    }
                    if let Some(frame) = frame {
                        let _ = app_clone.emit("can-message", frame);
                    }
                }
                Err(e) => {
                    log::error!("Task error: {}", e);
                    break;
                }
            }
        }
        
        log::info!("Receive loop ended for {}", interface_id_clone);
    });

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

/// Disconnect from the current CAN interface
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

/// Send a CAN message
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    app: AppHandle,
    frame: FramePayload,
) -> Result<(), String> {
    log::info!("send_message called with frame ID: 0x{:X}", frame.id);
    
    let channel = {
        let manager = state.channel_manager.read();
        manager
            .get_active_channel()
            .ok_or("No active channel")?
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
        let manager = state.channel_manager.read();
        manager
            .get_active_channel()
            .ok_or("No active channel")?
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

/// Set message filter
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
