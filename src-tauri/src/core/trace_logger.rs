use crate::core::message::CanFrame;
use chrono::{DateTime, Utc};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::{mpsc, RwLock};

/// Trace file format
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceFormat {
    Csv,
    Trc,
}

impl TraceFormat {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_lowercase().as_str() {
            "csv" => Some(Self::Csv),
            "trc" => Some(Self::Trc),
            _ => None,
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Trc => "trc",
        }
    }
}

/// Configuration for trace logging
#[derive(Debug, Clone)]
pub struct TraceLoggerConfig {
    pub format: TraceFormat,
    pub file_path: PathBuf,
    pub auto_split: bool,
    pub max_file_size_mb: Option<u64>,
    pub max_file_duration_sec: Option<u64>,
}

impl Default for TraceLoggerConfig {
    fn default() -> Self {
        Self {
            format: TraceFormat::Csv,
            file_path: PathBuf::from("trace.csv"),
            auto_split: false,
            max_file_size_mb: None,
            max_file_duration_sec: None,
        }
    }
}

/// Trace logger state
pub struct TraceLogger {
    config: Arc<RwLock<TraceLoggerConfig>>,
    writer: Option<BufWriter<File>>,
    message_tx: Option<mpsc::UnboundedSender<CanFrame>>,
    message_rx: Option<mpsc::UnboundedReceiver<CanFrame>>,
    start_time: Option<DateTime<Utc>>,
    frame_count: u64,
    current_file_size: u64,
}

impl TraceLogger {
    pub fn new(config: TraceLoggerConfig) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            config: Arc::new(RwLock::new(config)),
            writer: None,
            message_tx: Some(tx),
            message_rx: Some(rx),
            start_time: None,
            frame_count: 0,
            current_file_size: 0,
        }
    }

    /// Get a sender for logging messages
    pub fn get_sender(&self) -> Option<mpsc::UnboundedSender<CanFrame>> {
        self.message_tx.clone()
    }

    /// Start logging to file
    pub async fn start(&mut self) -> Result<(), String> {
        if self.writer.is_some() {
            return Err("Logger already started".to_string());
        }

        let config = self.config.read().await;
        let file = File::create(&config.file_path)
            .await
            .map_err(|e| format!("Failed to create trace file: {}", e))?;

        let mut writer = BufWriter::new(file);

        // Write header based on format
        match config.format {
            TraceFormat::Csv => {
                let header = "Time,ID,Extended,Remote,DLC,Data,Direction,Channel\n";
                writer
                    .write_all(header.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write CSV header: {}", e))?;
            }
            TraceFormat::Trc => {
                // TRC format header (Peak format)
                let header = format!(
                    "$FILEVERSION={}\n$STARTTIME={}\n",
                    "2.0",
                    Utc::now().format("%Y-%m-%d %H:%M:%S%.3f")
                );
                writer
                    .write_all(header.as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write TRC header: {}", e))?;
            }
        }

        self.writer = Some(writer);
        self.start_time = Some(Utc::now());
        self.frame_count = 0;
        self.current_file_size = 0;

        // Start background writer task
        if let Some(mut rx) = self.message_rx.take() {
            let writer = self.writer.take().unwrap();
            // Read config values before spawning
            let config_format = {
                let cfg = self.config.read().await;
                cfg.format
            };
            let config_path = {
                let cfg = self.config.read().await;
                cfg.file_path.clone()
            };
            let config_auto_split = {
                let cfg = self.config.read().await;
                cfg.auto_split
            };
            let config_max_size = {
                let cfg = self.config.read().await;
                cfg.max_file_size_mb
            };
            let config_max_duration = {
                let cfg = self.config.read().await;
                cfg.max_file_duration_sec
            };
            let start_time = self.start_time.unwrap();

            tokio::spawn(async move {
                let mut writer = writer;
                let mut frame_count = 0u64;
                let mut current_file_size = 0u64;

                while let Some(frame) = rx.recv().await {
                    frame_count += 1;

                    // Write frame based on format
                    let line = match config_format {
                        TraceFormat::Csv => {
                            let data_hex = frame
                                .data
                                .iter()
                                .map(|b| format!("{:02X}", b))
                                .collect::<Vec<_>>()
                                .join(" ");
                            let id_str = if frame.is_extended {
                                format!("{:08X}", frame.id)
                            } else {
                                format!("{:03X}", frame.id)
                            };
                            format!(
                                "{:.6},{},{},{},{},{},{},{}\n",
                                frame.timestamp,
                                id_str,
                                frame.is_extended,
                                frame.is_remote,
                                frame.dlc,
                                data_hex,
                                frame.direction,
                                frame.channel
                            )
                        }
                        TraceFormat::Trc => {
                            // TRC format: Time,Type,ID,Data Length,Data
                            // Type: Rx/Tx, Extended flag
                            let type_str = if frame.is_extended {
                                if frame.direction == "rx" {
                                    "Rx"
                                } else {
                                    "Tx"
                                }
                            } else {
                                if frame.direction == "rx" {
                                    "rx"
                                } else {
                                    "tx"
                                }
                            };
                            let data_hex = frame
                                .data
                                .iter()
                                .map(|b| format!("{:02X}", b))
                                .collect::<Vec<_>>()
                                .join(" ");
                            let id_str = if frame.is_extended {
                                format!("{:08X}", frame.id)
                            } else {
                                format!("{:03X}", frame.id)
                            };
                            format!(
                                " {:11.6} {} {} {} {}\n",
                                frame.timestamp * 1000.0, // Convert to ms
                                type_str,
                                id_str,
                                frame.dlc,
                                data_hex
                            )
                        }
                    };

                    if let Err(e) = writer.write_all(line.as_bytes()).await {
                        log::error!("Failed to write trace line: {}", e);
                        break;
                    }

                    current_file_size += line.len() as u64;

                    // Check if we need to split file
                    let should_split = if !config_auto_split {
                        false
                    } else if let Some(max_size) = config_max_size {
                        current_file_size > max_size * 1024 * 1024
                    } else if let Some(max_duration) = config_max_duration {
                        let elapsed = (Utc::now() - start_time).num_seconds() as u64;
                        elapsed > max_duration
                    } else {
                        false
                    };

                    if should_split {
                        // Flush current file
                        if let Err(e) = writer.flush().await {
                            log::error!("Failed to flush trace file: {}", e);
                        }

                        // Create new file
                        let new_path = Self::generate_split_path(&config_path, frame_count);
                        let new_file = match File::create(&new_path).await {
                            Ok(f) => f,
                            Err(e) => {
                                log::error!("Failed to create split file: {}", e);
                                break;
                            }
                        };

                        writer = BufWriter::new(new_file);

                        // Write header to new file
                        match config_format {
                            TraceFormat::Csv => {
                                let header = "Time,ID,Extended,Remote,DLC,Data,Direction,Channel\n";
                                if let Err(e) = writer.write_all(header.as_bytes()).await {
                                    log::error!("Failed to write CSV header: {}", e);
                                    break;
                                }
                            }
                            TraceFormat::Trc => {
                                let header = format!(
                                    "$FILEVERSION={}\n$STARTTIME={}\n",
                                    "2.0",
                                    Utc::now().format("%Y-%m-%d %H:%M:%S%.3f")
                                );
                                if let Err(e) = writer.write_all(header.as_bytes()).await {
                                    log::error!("Failed to write TRC header: {}", e);
                                    break;
                                }
                            }
                        }

                        current_file_size = 0;
                    }

                    // Periodic flush (every 100 frames or 1 second)
                    if frame_count % 100 == 0 {
                        if let Err(e) = writer.flush().await {
                            log::error!("Failed to flush trace file: {}", e);
                        }
                    }
                }

                // Final flush
                if let Err(e) = writer.flush().await {
                    log::error!("Failed to final flush trace file: {}", e);
                }
            });
        }

        Ok(())
    }

    /// Stop logging and close file
    pub async fn stop(&mut self) -> Result<(), String> {
        // Drop the sender to signal the writer task to stop
        self.message_tx = None;

        // Wait a bit for the writer to finish
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

        if let Some(mut writer) = self.writer.take() {
            writer
                .flush()
                .await
                .map_err(|e| format!("Failed to flush trace file: {}", e))?;
        }

        Ok(())
    }

    /// Update configuration
    pub async fn update_config(&mut self, config: TraceLoggerConfig) {
        *self.config.write().await = config;
    }

    /// Get current frame count
    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }

    /// Generate split file path
    fn generate_split_path(base_path: &PathBuf, split_num: u64) -> PathBuf {
        let mut new_path = base_path.clone();
        let stem = new_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("trace");
        let ext = new_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("csv");

        if let Some(parent) = new_path.parent() {
            new_path = parent.join(format!("{}_{}.{}", stem, split_num, ext));
        } else {
            new_path = PathBuf::from(format!("{}_{}.{}", stem, split_num, ext));
        }

        new_path
    }
}

impl Default for TraceLogger {
    fn default() -> Self {
        Self::new(TraceLoggerConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trace_format_from_extension() {
        assert_eq!(TraceFormat::from_extension("csv"), Some(TraceFormat::Csv));
        assert_eq!(TraceFormat::from_extension("trc"), Some(TraceFormat::Trc));
        assert_eq!(TraceFormat::from_extension("txt"), None);
    }

    #[test]
    fn test_trace_format_extension() {
        assert_eq!(TraceFormat::Csv.extension(), "csv");
        assert_eq!(TraceFormat::Trc.extension(), "trc");
    }
}

