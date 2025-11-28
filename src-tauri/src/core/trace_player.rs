use crate::core::message::CanFrame;
use std::collections::VecDeque;
use std::path::PathBuf;
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, BufReader};

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
    pub async fn load_file(&mut self, path: PathBuf) -> Result<usize, String> {
        let file = File::open(&path)
            .await
            .map_err(|e| format!("Failed to open trace file: {}", e))?;

        let reader = BufReader::new(file);
        let mut lines = reader.lines();

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

        let mut frames = VecDeque::new();
        let mut line_num = 0;

        // Skip header lines
        while let Some(line) = lines.next_line().await.map_err(|e| {
            format!("Failed to read trace file at line {}: {}", line_num, e)
        })? {
            line_num += 1;

            // Skip header lines
            if line.starts_with('$') || line.starts_with("Time") {
                continue;
            }

            if line.trim().is_empty() {
                continue;
            }

            // Parse frame based on format
            match format {
                TraceFormat::Csv => {
                    if let Ok(frame) = Self::parse_csv_line(&line) {
                        frames.push_back(frame);
                    }
                }
                TraceFormat::Trc => {
                    if let Ok(frame) = Self::parse_trc_line(&line) {
                        frames.push_back(frame);
                    }
                }
            }
        }

        self.frames = frames;
        self.current_index = 0;
        self.state = PlaybackState::Stopped;

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
            return None;
        }

        let current_frame = self.frames[self.current_index].clone();
        let current_timestamp = current_frame.timestamp;

        // Calculate delay until next frame
        let delay = if self.current_index + 1 < self.frames.len() {
            let next_timestamp = self.frames[self.current_index + 1].timestamp;
            let delta = (next_timestamp - current_timestamp) / self.playback_speed;
            tokio::time::Duration::from_secs_f64(delta.max(0.0))
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

    /// Parse TRC line (Peak format)
    fn parse_trc_line(line: &str) -> Result<CanFrame, String> {
        // TRC format: " Time Type ID DLC Data"
        // Example: "  0.001234 Rx 123 8 01 02 03 04 05 06 07 08"
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            return Err("Invalid TRC line format".to_string());
        }

        let timestamp_ms = parts[0].trim().parse::<f64>().map_err(|e| {
            format!("Failed to parse timestamp: {}", e)
        })?;
        let timestamp = timestamp_ms / 1000.0; // Convert to seconds

        let type_str = parts[1].trim();
        let is_extended = type_str == "Rx" || type_str == "Tx";
        let direction = if type_str.to_lowercase().starts_with('r') {
            "rx"
        } else {
            "tx"
        };

        let id_str = parts[2].trim().replace("0x", "").replace("0X", "");
        let id = u32::from_str_radix(&id_str, 16).map_err(|e| {
            format!("Failed to parse ID: {}", e)
        })?;

        let dlc = parts[3].trim().parse::<u8>().map_err(|e| {
            format!("Failed to parse DLC: {}", e)
        })?;

        let data: Result<Vec<u8>, _> = parts[4..]
            .iter()
            .take(dlc as usize)
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
            channel: "playback".to_string(),
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
#[derive(Debug, Clone, Copy)]
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
        let line = "  1.234567 Rx 123 8 01 02 03 04 05 06 07 08";
        let frame = TracePlayer::parse_trc_line(line).unwrap();
        assert_eq!(frame.id, 0x123);
        assert_eq!(frame.dlc, 8);
        assert_eq!(frame.direction, "rx");
    }
}

