use crate::core::message::CanFrame;
use std::collections::VecDeque;
use std::path::PathBuf;
use tokio::fs;
use rayon::prelude::*;

/// Playback state
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlaybackState {
    Stopped,
    Playing,
    Paused,
}

/// Trace player for replaying log files
pub struct TracePlayer {
    frames: VecDeque<CanFrame>,
    current_index: usize,
    playback_speed: f64,
    state: PlaybackState,
    start_time: Option<tokio::time::Instant>,
    playback_start_timestamp: f64,
}

impl TracePlayer {
    pub fn new() -> Self {
        Self {
            frames: VecDeque::new(),
            current_index: 0,
            playback_speed: 1.0,
            state: PlaybackState::Stopped,
            start_time: None,
            playback_start_timestamp: 0.0,
        }
    }

    /// Load trace file (CSV or TRC format)
    /// progress_callback: Optional callback that receives (current_line) for progress reporting
    pub async fn load_file(
        &mut self, 
        path: PathBuf, 
        bus_to_channel: Option<std::collections::HashMap<u8, String>>,
        progress_callback: Option<Box<dyn Fn(usize) + Send + Sync>>,
    ) -> Result<usize, String> {
        // Detect format from extension
        let format = path
            .extension()
            .and_then(|ext| ext.to_str())
            .and_then(|ext| match ext.to_lowercase().as_str() {
                "csv" => Some(TraceFormat::Csv),
                "trc" => Some(TraceFormat::Trc),
                _ => None,
            })
            .ok_or_else(|| "Unknown file format. Expected .csv or .trc".to_string())?;

        // Read entire file into memory for parallel processing
        // For large files (1.7M lines), this is acceptable (~100-200MB)
        let file_contents = fs::read_to_string(&path)
            .await
            .map_err(|e| format!("Failed to read trace file: {}", e))?;
        
        let all_lines: Vec<&str> = file_contents.lines().collect();
        let total_lines = all_lines.len();
        
        // Parse header to find STARTTIME (for TRC files)
        let mut start_time_days: Option<f64> = None;
        let mut data_start_idx = 0;
        
        if format == TraceFormat::Trc {
            for (idx, line) in all_lines.iter().enumerate() {
                if line.starts_with(";$STARTTIME=") {
                    let value = line.trim_start_matches(";$STARTTIME=").trim();
                    start_time_days = value.parse::<f64>().ok();
                }
                // Find where data lines start (after headers)
                if !line.starts_with('$') && !line.starts_with(';') && 
                   !line.trim().is_empty() && 
                   !line.contains("Message") && 
                   !line.starts_with("---+---") &&
                   line.len() > 10 {
                    data_start_idx = idx;
                    break;
                }
            }
        } else {
            // CSV: find header line
            for (idx, line) in all_lines.iter().enumerate() {
                if line.starts_with("Time") || line.starts_with("time") {
                    data_start_idx = idx + 1;
                    break;
                }
            }
        }
        
        // Extract data lines for parallel processing
        let data_lines = &all_lines[data_start_idx..];
        
        // Parse lines in parallel using rayon
        let bus_to_channel_clone = bus_to_channel.clone();
        let start_time_days_clone = start_time_days;
        
        let parsed_frames: Vec<Result<CanFrame, String>> = data_lines
            .par_iter()
            .enumerate()
            .map(|(idx, line)| {
                // Emit progress every 10000 lines
                if let Some(ref callback) = progress_callback {
                    if idx > 0 && idx % 10000 == 0 {
                        callback(data_start_idx + idx);
                    }
                }
                
                if line.trim().is_empty() {
                    return Err("Empty line".to_string());
                }
                
                match format {
                    TraceFormat::Csv => {
                        Self::parse_csv_line(line).map_err(|e| e.to_string())
                    }
                    TraceFormat::Trc => {
                        Self::parse_trc_line(line, start_time_days_clone, &bus_to_channel_clone)
                    }
                }
            })
            .collect();
        
        // Collect successful frames and sort by timestamp
        let mut frames: Vec<CanFrame> = parsed_frames
            .into_iter()
            .filter_map(|r| r.ok())
            .collect();
        
        // Sort by timestamp to maintain chronological order
        frames.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap_or(std::cmp::Ordering::Equal));
        
        // Convert to VecDeque
        self.frames = frames.into_iter().collect();

        self.current_index = 0;
        self.state = PlaybackState::Stopped;
        self.playback_start_timestamp = 0.0;
        
        // Emit final progress
        if let Some(ref callback) = progress_callback {
            callback(total_lines);
        }

        Ok(self.frames.len())
    }

    /// Start playback
    pub fn start(&mut self) -> Result<(), String> {
        if self.frames.is_empty() {
            return Err("No frames loaded".to_string());
        }

        if self.current_index >= self.frames.len() {
            self.current_index = 0; // Reset to beginning
        }

        self.state = PlaybackState::Playing;
        self.start_time = Some(tokio::time::Instant::now());
        if let Some(frame) = self.frames.get(self.current_index) {
            self.playback_start_timestamp = frame.timestamp;
            log::info!("Starting playback: {} frames, first timestamp: {}", self.frames.len(), frame.timestamp);
        }

        Ok(())
    }

    /// Stop playback
    pub fn stop(&mut self) {
        self.state = PlaybackState::Stopped;
        self.current_index = 0;
        self.start_time = None;
    }

    /// Pause playback
    pub fn pause(&mut self) {
        if self.state == PlaybackState::Playing {
            self.state = PlaybackState::Paused;
        }
    }

    /// Resume playback
    pub fn resume(&mut self) {
        if self.state == PlaybackState::Paused {
            self.state = PlaybackState::Playing;
            // Adjust start time to account for pause duration
            if let Some(start) = self.start_time {
                let paused_duration = start.elapsed();
                self.start_time = Some(tokio::time::Instant::now() - paused_duration);
            }
        }
    }

    /// Set playback speed (0.1x to 5.0x)
    pub fn set_speed(&mut self, speed: f64) {
        self.playback_speed = speed.max(0.1).min(5.0);
    }

    /// Get current playback speed
    pub fn get_speed(&self) -> f64 {
        self.playback_speed
    }

    /// Seek to a specific frame index
    pub fn seek(&mut self, index: usize) {
        self.current_index = index.min(self.frames.len().saturating_sub(1));
    }

    /// Get next frame to send (returns frame and delay until next frame)
    pub fn get_next_frame(&mut self) -> Option<(CanFrame, tokio::time::Duration)> {
        if self.state != PlaybackState::Playing {
            return None;
        }

        if self.current_index >= self.frames.len() {
            self.state = PlaybackState::Stopped;
            log::info!("Playback finished: reached end of trace");
            return None;
        }

        let current_frame = self.frames[self.current_index].clone();
        let current_timestamp = current_frame.timestamp;

        // Calculate delay until next frame
        // Use relative time from playback start for delay calculation
        let delay = if self.current_index + 1 < self.frames.len() {
            let next_timestamp = self.frames[self.current_index + 1].timestamp;
            let delta = (next_timestamp - current_timestamp) / self.playback_speed;
            let delay_duration = tokio::time::Duration::from_secs_f64(delta.max(0.0));
            // Cap delay at 1 second to prevent very long waits
            if delay_duration.as_secs_f64() > 1.0 {
                tokio::time::Duration::from_secs(1)
            } else {
                delay_duration
            }
        } else {
            // Last frame
            tokio::time::Duration::from_secs(0)
        };

        self.current_index += 1;

        Some((current_frame, delay))
    }

    /// Get playback state
    pub fn get_state(&self) -> PlaybackState {
        self.state.clone()
    }

    /// Get current frame index
    pub fn get_current_index(&self) -> usize {
        self.current_index
    }

    /// Get total frame count
    pub fn get_frame_count(&self) -> usize {
        self.frames.len()
    }

    /// Get all loaded frames (for immediate decoding)
    pub fn get_all_frames(&self) -> Vec<CanFrame> {
        self.frames.iter().cloned().collect()
    }

    /// Parse CSV line
    fn parse_csv_line(line: &str) -> Result<CanFrame, String> {
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 8 {
            return Err("Invalid CSV line format".to_string());
        }

        let timestamp = parts[0].trim().parse::<f64>().map_err(|e| {
            format!("Failed to parse timestamp: {}", e)
        })?;

        let id_str = parts[1].trim().replace("0x", "").replace("0X", "");
        let id = u32::from_str_radix(&id_str, 16).map_err(|e| {
            format!("Failed to parse ID: {}", e)
        })?;

        let is_extended = parts[2].trim().parse::<bool>().unwrap_or(false);
        let is_remote = parts[3].trim().parse::<bool>().unwrap_or(false);
        let dlc = parts[4].trim().parse::<u8>().map_err(|e| {
            format!("Failed to parse DLC: {}", e)
        })?;

        let data_str = parts[5].trim();
        let data: Result<Vec<u8>, _> = data_str
            .split_whitespace()
            .map(|b| u8::from_str_radix(b, 16))
            .collect();
        let data = data.map_err(|e| format!("Failed to parse data: {:?}", e))?;

        let direction = parts[6].trim().to_string();
        let channel = parts[7].trim().to_string();

        Ok(CanFrame {
            id,
            is_extended,
            is_remote,
            dlc,
            data,
            timestamp,
            channel,
            direction,
        })
    }

    /// Parse TRC line (PCAN-Explorer format)
    /// Format varies:
    ///   With Type: "1        77.686 DT 3      0132 Rx -  8    C4 00 00 00 00 00 00 00"
    ///   Without Type: "1)         0.274 1  Rx        011C -  8    00 00 00 00 00 00 00 80"
    /// N = Number, O = Time Offset (ms), T = Type (optional), B = Bus, I = ID (hex), d = direction, R = Reserved, L = Length, D = Data
    fn parse_trc_line(
        line: &str,
        start_time_days: Option<f64>,
        bus_to_channel: &Option<std::collections::HashMap<u8, String>>,
    ) -> Result<CanFrame, String> {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 8 {
            return Err(format!("Invalid TRC line format: not enough fields (got {}, need 8+). Line: {}", parts.len(), line));
        }

        // Detect format: if parts[2] looks like a number, it's the bus (no Type field)
        // If parts[2] looks like "DT" or similar, parts[3] is the bus (with Type field)
        let (time_offset_idx, bus_idx, id_idx, direction_idx, dlc_idx, data_start_idx) = 
            if parts.len() >= 3 && parts[2].trim().parse::<u8>().is_ok() {
                // Format without Type: "1) 0.274 1 Rx 011C - 8 00 00..."
                // parts[0] = "1)", parts[1] = "0.274", parts[2] = "1" (bus), parts[3] = "Rx", parts[4] = "011C" (ID)
                (1, 2, 4, 3, 6, 7)
            } else {
                // Format with Type: "1 77.686 DT 3 0132 Rx - 8 C4 00..."
                // parts[0] = "1", parts[1] = "77.686", parts[2] = "DT", parts[3] = "3" (bus), parts[4] = "0132" (ID)
                (1, 3, 4, 5, 7, 8)
            };

        // Parse time offset (column O) - milliseconds from STARTTIME
        let time_offset_ms = parts[time_offset_idx].trim().parse::<f64>().map_err(|e| {
            format!("Failed to parse time offset '{}': {}", parts[time_offset_idx], e)
        })?;
        
        // Calculate absolute timestamp
        // STARTTIME is MS Basic Decimal Days since Dec 31, 1899
        // Convert to seconds since Unix epoch, then add time offset
        let timestamp = if let Some(start_days) = start_time_days {
            // Convert MS Basic days to Unix timestamp
            // Dec 31, 1899 to Jan 1, 1970 = 25569 days
            let unix_epoch_days = 25569.0;
            let days_since_epoch = start_days - unix_epoch_days;
            let seconds_since_epoch = days_since_epoch * 86400.0;
            seconds_since_epoch + (time_offset_ms / 1000.0)
        } else {
            // If no STARTTIME, use relative time from start (offset in seconds)
            time_offset_ms / 1000.0
        };

        // Parse bus number (column B)
        let bus_num = parts[bus_idx].trim().parse::<u8>().map_err(|e| {
            format!("Failed to parse bus number '{}' at index {}: {}", parts[bus_idx], bus_idx, e)
        })?;

        // Map bus number to channel ID
        let channel = if let Some(ref mapping) = bus_to_channel {
            mapping.get(&bus_num)
                .cloned()
                .unwrap_or_else(|| {
                    log::warn!("Bus {} not found in mapping, using fallback channel_{}. Available buses: {:?}", 
                        bus_num, bus_num, mapping.keys().collect::<Vec<_>>());
                    format!("channel_{}", bus_num)
                })
        } else {
            log::warn!("No bus-to-channel mapping provided, using channel_{}", bus_num);
            format!("channel_{}", bus_num)
        };
        
        // Parse ID (column I) - hex without 0x prefix
        let id_str = parts[id_idx].trim();
        let id = u32::from_str_radix(id_str, 16).map_err(|e| {
            format!("Failed to parse ID '{}': {}", id_str, e)
        })?;

        // Determine if extended (29-bit) - IDs > 0x7FF are extended
        let is_extended = id > 0x7FF;

        // Parse direction (column d)
        let direction_str = parts[direction_idx].trim();
        let direction = if direction_str.to_lowercase().starts_with('r') {
            "rx"
        } else {
            "tx"
        };

        // Reserved (column R) - skip (usually "-")
        // Parse length/DLC (column L)
        let dlc = parts[dlc_idx].trim().parse::<u8>().map_err(|e| {
            format!("Failed to parse DLC '{}' at index {}: {}", parts[dlc_idx], dlc_idx, e)
        })?;

        // Parse data (column D) - hex bytes starting at data_start_idx
        if parts.len() < data_start_idx + dlc as usize {
            return Err(format!("Not enough data bytes: need {} but only have {} parts", 
                data_start_idx + dlc as usize, parts.len()));
        }
        let data: Result<Vec<u8>, _> = parts[data_start_idx..data_start_idx + dlc as usize]
            .iter()
            .map(|b| u8::from_str_radix(b, 16))
            .collect();
        let data = data.map_err(|e| format!("Failed to parse data: {:?}", e))?;

        Ok(CanFrame {
            id,
            is_extended,
            is_remote: false,
            dlc,
            data,
            timestamp,
            channel,
            direction: direction.to_string(),
        })
    }
}

impl Default for TracePlayer {
    fn default() -> Self {
        Self::new()
    }
}

/// Trace file format for parsing
#[derive(Debug, Clone, Copy, PartialEq)]
enum TraceFormat {
    Csv,
    Trc,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_csv_line() {
        let line = "0.001234,123,false,false,8,01 02 03 04 05 06 07 08,rx,can0";
        let frame = TracePlayer::parse_csv_line(line).unwrap();
        assert_eq!(frame.id, 0x123);
        assert_eq!(frame.dlc, 8);
        assert_eq!(frame.direction, "rx");
    }

    #[test]
    fn test_parse_trc_line() {
        // TRC format: "       1        77.686 DT 3      0132 Rx -  8    C4 00 00 00 00 00 00 00"
        // Format: Number, Time Offset [ms], Type, Bus, ID [hex], Direction, Reserved, DLC, Data...
        let line = "       1        77.686 DT 3      0132 Rx -  8    C4 00 00 00 00 00 00 00";
        let start_time_days = Some(45345.123456); // Example MS Basic Decimal Days
        let bus_to_channel = &None; // No channel mapping for test
        let frame = TracePlayer::parse_trc_line(line, start_time_days, bus_to_channel).unwrap();
        assert_eq!(frame.id, 0x132);
        assert_eq!(frame.dlc, 8);
        assert_eq!(frame.direction, "rx");
        assert_eq!(frame.channel, "channel_3"); // Default channel when no mapping
    }
}

