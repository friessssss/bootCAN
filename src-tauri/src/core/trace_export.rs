//! Export a captured trace as PEAK PCAN-Trace 2.1 (`.trc`) or Lightship MCAP.
//!
//! TRC layout matches PEAK `$COLUMNS=N,O,T,B,I,d,R,L,D` and the writer in
//! `log-browser/log_browser/trc_writer.py` (CRLF, OLE start time, DT/RR/FD).
//! MCAP matches the log-browser decoded export: `can/{MessageName}` with a
//! `DecodedCan_{MessageName}` schema when a symbol file knows the ID, and
//! `can/0x…` `CanFrameV1` otherwise.

use crate::core::dbc::{DbcDatabase, Message};
use crate::core::trace_buffer::{system_now_ns, CapturedFrame};
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// Days from the OLE Automation epoch (1899-12-30) to the Unix epoch.
/// Same constant the TRC playback parser uses.
const OLE_UNIX_DAYS: f64 = 25569.0;

const CANFRAME_V1_SCHEMA: &str = r#"{"type":"object","properties":{"ts_ns":{"type":"integer"},"arbitration_id":{"type":"integer"},"is_extended_id":{"type":"boolean"},"is_remote_frame":{"type":"boolean"},"is_error_frame":{"type":"boolean"},"is_fd":{"type":"boolean"},"bitrate_switch":{"type":"boolean"},"error_state_indicator":{"type":"boolean"},"dlc":{"type":"integer"},"data":{"type":"array","items":{"type":"integer"}}},"required":["ts_ns","arbitration_id","dlc","data"]}"#;

/// A net as it should appear in the TRC bus column and MCAP topic.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceBus {
    pub channel_id: String,
    pub name: String,
    pub bus: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Trc,
    Mcap,
    Csv,
}

impl ExportFormat {
    pub fn from_str(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "trc" => Some(Self::Trc),
            "mcap" => Some(Self::Mcap),
            "csv" => Some(Self::Csv),
            _ => None,
        }
    }
}

/// Write `frames` (sorted by time here) to `path`.
pub fn export_trace(
    path: &Path,
    format: ExportFormat,
    start_epoch_ns: u64,
    frames: &mut [CapturedFrame],
    buses: &[TraceBus],
    databases: &HashMap<String, DbcDatabase>,
) -> Result<u64, String> {
    if frames.is_empty() {
        return Err("No trace frames to export".to_string());
    }
    frames.sort_by_key(|f| f.offset_ns);
    let start_epoch_ns = if start_epoch_ns == 0 {
        system_now_ns()
    } else {
        start_epoch_ns
    };
    match format {
        ExportFormat::Trc => {
            write_atomic(path, |tmp| write_trc(tmp, start_epoch_ns, frames, buses))
        }
        ExportFormat::Mcap => write_atomic(path, |tmp| {
            write_mcap(tmp, start_epoch_ns, frames, databases)
        }),
        ExportFormat::Csv => write_atomic(path, |tmp| write_csv(tmp, frames)),
    }
}

/// Turn player frames into export frames.
///
/// Timestamps above 1e9 are treated as Unix seconds (TRC files loaded with
/// `$STARTTIME`). Smaller values are offsets from the start of the file.
pub fn frames_from_player(frames: &[crate::core::message::CanFrame]) -> (u64, Vec<CapturedFrame>) {
    let Some(first) = frames.first() else {
        return (0, Vec::new());
    };
    let absolute = first.timestamp > 1_000_000_000.0;
    let start_epoch_ns = if absolute {
        (first.timestamp * 1e9).round() as u64
    } else {
        system_now_ns()
    };
    let captured = frames
        .iter()
        .map(|frame| {
            let delta = if absolute {
                (frame.timestamp - first.timestamp).max(0.0)
            } else {
                frame.timestamp.max(0.0)
            };
            let n = if frame.is_remote {
                0
            } else {
                (frame.dlc as usize).min(frame.data.len()).min(64)
            };
            CapturedFrame {
                offset_ns: (delta * 1e9).round() as u64,
                id: frame.id,
                is_extended: frame.is_extended,
                is_remote: frame.is_remote,
                dlc: frame.dlc,
                data: frame.data[..n].to_vec(),
                channel: frame.channel.clone(),
                is_tx: frame.direction.eq_ignore_ascii_case("tx"),
            }
        })
        .collect();
    (start_epoch_ns, captured)
}

fn bus_assignments(frames: &[CapturedFrame], buses: &[TraceBus]) -> HashMap<String, (u8, String)> {
    let mut map = HashMap::new();
    let mut used: HashSet<u8> = HashSet::new();
    let mut next: u16 = 1;
    for frame in frames {
        if map.contains_key(&frame.channel) {
            continue;
        }
        if let Some(bus) = buses.iter().find(|b| b.channel_id == frame.channel) {
            used.insert(bus.bus);
            map.insert(frame.channel.clone(), (bus.bus, bus.name.clone()));
            continue;
        }
        while next <= 255 && used.contains(&(next as u8)) {
            next += 1;
        }
        let bus = if next <= 255 { next as u8 } else { 1 };
        used.insert(bus);
        let name = if frame.channel.is_empty() {
            format!("bus{bus}")
        } else {
            frame.channel.clone()
        };
        map.insert(frame.channel.clone(), (bus, name));
    }
    map
}

/// One v2.1 message line, without the line ending.
///
/// Column widths follow `log_browser.trc_writer._MSG_FMT`.
pub fn format_trc_line(frame: &CapturedFrame, msg_nr: u64, bus: u8) -> String {
    let offset_ms = frame.offset_ns as f64 / 1e6;
    let kind = if frame.is_remote {
        "RR"
    } else if frame.dlc > 8 || frame.data.len() > 8 {
        "FD"
    } else {
        "DT"
    };
    let id = if frame.is_extended {
        format!("{:07X}", frame.id)
    } else {
        format!("{:X}", frame.id)
    };
    let dir = if frame.is_tx { "Tx" } else { "Rx" };
    let data = frame
        .data
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "{msg_nr:>7}{offset_ms:13.3} {kind:<2} {bus} {id:>8} {dir:>2} - {dlc:<4}{data}",
        dlc = frame.dlc
    )
}

fn write_trc(
    path: &Path,
    start_epoch_ns: u64,
    frames: &[CapturedFrame],
    buses: &[TraceBus],
) -> Result<u64, String> {
    let file = File::create(path).map_err(|e| format!("Failed to create TRC file: {e}"))?;
    let mut out = BufWriter::new(file);
    let buses_by_channel = bus_assignments(frames, buses);
    write_trc_header(&mut out, start_epoch_ns, &buses_by_channel)?;

    for (idx, frame) in frames.iter().enumerate() {
        let bus = buses_by_channel
            .get(&frame.channel)
            .map(|(bus, _)| *bus)
            .unwrap_or(1);
        let line = format_trc_line(frame, (idx + 1) as u64, bus);
        out.write_all(line.as_bytes())
            .and_then(|_| out.write_all(b"\r\n"))
            .map_err(|e| format!("Failed to write TRC frame: {e}"))?;
    }
    out.flush()
        .map_err(|e| format!("Failed to flush TRC file: {e}"))?;
    Ok(frames.len() as u64)
}

fn write_trc_header(
    out: &mut BufWriter<File>,
    start_epoch_ns: u64,
    buses: &HashMap<String, (u8, String)>,
) -> Result<(), String> {
    let start_secs = start_epoch_ns as f64 / 1e9;
    let ole_days = start_secs / 86400.0 + OLE_UNIX_DAYS;
    let start_label = chrono::DateTime::<chrono::Utc>::from_timestamp(
        (start_epoch_ns / 1_000_000_000) as i64,
        (start_epoch_ns % 1_000_000_000) as u32,
    )
    .map(|dt| dt.format("%Y-%m-%d %H:%M:%S%.3f UTC").to_string())
    .unwrap_or_else(|| "unknown".to_string());

    let mut lines = vec![
        format!(";$FILEVERSION=2.1"),
        format!(";$STARTTIME={ole_days:.10}"),
        ";$COLUMNS=N,O,T,B,I,d,R,L,D".to_string(),
        ";".to_string(),
        format!("; Start time: {start_label}"),
        format!("; Generated by bootCAN v{}", env!("CARGO_PKG_VERSION")),
        ";-------------------------------------------------------------------------------"
            .to_string(),
        ";   Bus  Name".to_string(),
    ];
    let mut listed: Vec<(u8, String)> = buses.values().cloned().collect();
    listed.sort_by_key(|(bus, _)| *bus);
    listed.dedup_by_key(|(bus, _)| *bus);
    if listed.is_empty() {
        lines.push(";   1    CAN".to_string());
    } else {
        for (bus, name) in listed {
            lines.push(format!(";   {bus:<4} {name}"));
        }
    }
    lines.extend([
        ";-------------------------------------------------------------------------------"
            .to_string(),
        ";   Message   Time    Type  Bus  ID       Rx/Tx".to_string(),
        ";   Number    Offset  |     |    [hex]    |     Reserved".to_string(),
        ";   |         [ms]    |     |    |        |     |  Data Length Code".to_string(),
        ";   |         |       |     |    |        |     |  |    Data [hex] ...".to_string(),
        ";   |         |       |     |    |        |     |  |    |".to_string(),
        ";---+-- ------+------ +- -- +- --+------- +- -- +- +--- +- -- -- -- -- -- -- --"
            .to_string(),
    ]);
    for line in lines {
        out.write_all(line.as_bytes())
            .and_then(|_| out.write_all(b"\r\n"))
            .map_err(|e| format!("Failed to write TRC header: {e}"))?;
    }
    Ok(())
}

fn write_csv(path: &Path, frames: &[CapturedFrame]) -> Result<u64, String> {
    let file = File::create(path).map_err(|e| format!("Failed to create CSV file: {e}"))?;
    let mut out = BufWriter::new(file);
    out.write_all(b"Time,ID,Extended,Remote,DLC,Data,Direction,Channel\n")
        .map_err(|e| format!("Failed to write CSV header: {e}"))?;
    for frame in frames {
        let data = frame
            .data
            .iter()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(" ");
        let id = if frame.is_extended {
            format!("{:08X}", frame.id)
        } else {
            format!("{:X}", frame.id)
        };
        let line = format!(
            "{:.6},{},{},{},{},{},{},{}\n",
            frame.offset_ns as f64 / 1e9,
            id,
            frame.is_extended,
            frame.is_remote,
            frame.dlc,
            data,
            if frame.is_tx { "tx" } else { "rx" },
            frame.channel
        );
        out.write_all(line.as_bytes())
            .map_err(|e| format!("Failed to write CSV frame: {e}"))?;
    }
    out.flush()
        .map_err(|e| format!("Failed to flush CSV file: {e}"))?;
    Ok(frames.len() as u64)
}

/// `can/0x16C` for 11-bit IDs, `can/0x10600404` for 29-bit IDs.
fn unknown_can_topic(id: u32, extended: bool) -> String {
    if extended {
        format!("can/0x{id:08X}")
    } else {
        format!("can/0x{id:03X}")
    }
}

fn decoded_schema(message: &Message) -> Vec<u8> {
    let mut properties = serde_json::Map::new();
    properties.insert(
        "_message".to_string(),
        serde_json::json!({"type": "string", "description": "Message name"}),
    );
    for signal in &message.signals {
        if signal.name == "_message" {
            continue;
        }
        let ty = if signal.value_table.is_some() {
            "string"
        } else {
            "number"
        };
        properties.insert(signal.name.clone(), serde_json::json!({"type": ty}));
    }
    serde_json::to_vec(&serde_json::json!({
        "type": "object",
        "properties": properties,
    }))
    .unwrap_or_else(|_| b"{}".to_vec())
}

fn decoded_payload(
    message: &Message,
    frame: &CapturedFrame,
    ts_ns: u64,
    db: &DbcDatabase,
) -> Vec<u8> {
    let decoded = db.decode_message(frame.id, &frame.data);
    let mut payload = serde_json::Map::new();
    payload.insert(
        "_message".to_string(),
        serde_json::Value::String(message.name.clone()),
    );
    for value in decoded {
        let is_enum = message
            .signals
            .iter()
            .find(|signal| signal.name == value.name)
            .and_then(|signal| signal.value_table.as_ref())
            .is_some();
        let json_value = if is_enum {
            serde_json::Value::String(value.value_name.unwrap_or_else(|| {
                if value.physical_value.fract() == 0.0 && value.physical_value.is_finite() {
                    format!("{}", value.physical_value as i64)
                } else {
                    format!("{}", value.physical_value)
                }
            }))
        } else if value.physical_value.is_finite() {
            serde_json::json!(value.physical_value)
        } else {
            continue;
        };
        payload.insert(value.name, json_value);
    }
    payload.insert("ts_ns".to_string(), serde_json::json!(ts_ns));
    serde_json::Value::Object(payload).to_string().into_bytes()
}

fn raw_can_payload(frame: &CapturedFrame, ts_ns: u64) -> Vec<u8> {
    let is_fd = frame.dlc > 8 || frame.data.len() > 8;
    serde_json::json!({
        "ts_ns": ts_ns,
        "arbitration_id": frame.id,
        "is_extended_id": frame.is_extended,
        "is_remote_frame": frame.is_remote,
        "is_error_frame": false,
        "is_fd": is_fd,
        "bitrate_switch": false,
        "error_state_indicator": false,
        "dlc": frame.dlc,
        "data": frame.data,
    })
    .to_string()
    .into_bytes()
}

fn write_mcap(
    path: &Path,
    start_epoch_ns: u64,
    frames: &[CapturedFrame],
    databases: &HashMap<String, DbcDatabase>,
) -> Result<u64, String> {
    let file = File::create(path).map_err(|e| format!("Failed to create MCAP file: {e}"))?;
    let options = mcap::WriteOptions::new()
        .compression(Some(mcap::Compression::Zstd))
        .library(format!("bootcan {}", env!("CARGO_PKG_VERSION")));
    let mut writer = options
        .create(BufWriter::new(file))
        .map_err(|e| format!("Failed to start MCAP writer: {e}"))?;

    let empty_meta = BTreeMap::new();
    let mut raw_schema: Option<u16> = None;
    let mut unknown_channels: HashMap<u32, u16> = HashMap::new();
    let mut decoded_channels: HashMap<String, u16> = HashMap::new();
    let mut sequences: HashMap<u16, u32> = HashMap::new();

    for frame in frames {
        let ts_ns = start_epoch_ns.saturating_add(frame.offset_ns);
        let known = databases
            .get(&frame.channel)
            .and_then(|db| db.get_message(frame.id))
            .cloned();

        if let Some(message) = known {
            let channel_id = if let Some(id) = decoded_channels.get(&message.name).copied() {
                id
            } else {
                let schema_name = format!("DecodedCan_{}", message.name);
                let schema_id = writer
                    .add_schema(&schema_name, "jsonschema", &decoded_schema(&message))
                    .map_err(|e| format!("Failed to register {schema_name}: {e}"))?;
                let id = writer
                    .add_channel(
                        schema_id,
                        &format!("can/{}", message.name),
                        "json",
                        &empty_meta,
                    )
                    .map_err(|e| format!("Failed to register can/{}: {e}", message.name))?;
                decoded_channels.insert(message.name.clone(), id);
                id
            };
            let bytes = decoded_payload(
                &message,
                frame,
                ts_ns,
                databases.get(&frame.channel).expect("database just found"),
            );
            emit_mcap(&mut writer, &mut sequences, channel_id, ts_ns, &bytes)?;
            continue;
        }

        let schema_id = if let Some(id) = raw_schema {
            id
        } else {
            let id = writer
                .add_schema("CanFrameV1", "jsonschema", CANFRAME_V1_SCHEMA.as_bytes())
                .map_err(|e| format!("Failed to register CanFrameV1 schema: {e}"))?;
            raw_schema = Some(id);
            id
        };
        let channel_id = if let Some(id) = unknown_channels.get(&frame.id) {
            *id
        } else {
            let id = writer
                .add_channel(
                    schema_id,
                    &unknown_can_topic(frame.id, frame.is_extended),
                    "json",
                    &empty_meta,
                )
                .map_err(|e| format!("Failed to register unknown CAN topic: {e}"))?;
            unknown_channels.insert(frame.id, id);
            id
        };
        let bytes = raw_can_payload(frame, ts_ns);
        emit_mcap(&mut writer, &mut sequences, channel_id, ts_ns, &bytes)?;
    }

    writer
        .finish()
        .map_err(|e| format!("Failed to finish MCAP file: {e}"))?;
    Ok(frames.len() as u64)
}

fn emit_mcap(
    writer: &mut mcap::Writer<BufWriter<File>>,
    sequences: &mut HashMap<u16, u32>,
    channel_id: u16,
    ts_ns: u64,
    bytes: &[u8],
) -> Result<(), String> {
    let seq = sequences.entry(channel_id).or_insert(0);
    *seq = seq.saturating_add(1);
    writer
        .write_to_known_channel(
            &mcap::records::MessageHeader {
                channel_id,
                sequence: *seq,
                log_time: ts_ns,
                publish_time: ts_ns,
            },
            bytes,
        )
        .map_err(|e| format!("Failed to write MCAP frame: {e}"))
}

fn write_atomic(
    path: &Path,
    write: impl FnOnce(&Path) -> Result<u64, String>,
) -> Result<u64, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {}: {e}", parent.display()))?;
        }
    }
    let tmp = partial_path(path);
    match write(&tmp) {
        Ok(count) => {
            fs::rename(&tmp, path).map_err(|e| {
                let _ = fs::remove_file(&tmp);
                format!("Failed to save {}: {e}", path.display())
            })?;
            Ok(count)
        }
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            Err(err)
        }
    }
}

fn partial_path(path: &Path) -> PathBuf {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("part");
    path.with_extension(format!("{ext}.partial"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::trace_player::TracePlayer;
    use std::collections::HashMap as StdHashMap;

    fn sample(
        offset_ns: u64,
        id: u32,
        extended: bool,
        remote: bool,
        tx: bool,
        data: &[u8],
    ) -> CapturedFrame {
        CapturedFrame {
            offset_ns,
            id,
            is_extended: extended,
            is_remote: remote,
            dlc: if remote { 2 } else { data.len() as u8 },
            data: if remote { Vec::new() } else { data.to_vec() },
            channel: "net-a".to_string(),
            is_tx: tx,
        }
    }

    #[test]
    fn trc_line_matches_peak_column_layout() {
        let frame = sample(
            0,
            0x132,
            false,
            false,
            false,
            &[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
        );
        let line = format_trc_line(&frame, 1, 3);
        assert_eq!(
            line,
            "      1        0.000 DT 3      132 Rx - 8   11 22 33 44 55 66 77 88"
        );
    }

    #[tokio::test]
    async fn trc_roundtrip_preserves_id_direction_and_extended_flag() {
        let start_ns = 1_700_000_000_000_000_000;
        let mut frames = vec![
            sample(
                0,
                0x132,
                false,
                false,
                false,
                &[0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
            ),
            sample(1_500_000, 0x10, false, false, true, &[0xAA]),
            sample(2_000_000, 0x100, true, false, false, &[0x01]),
            sample(3_000_000, 0x42, false, true, false, &[]),
        ];
        let buses = vec![TraceBus {
            channel_id: "net-a".to_string(),
            name: "Vehicle 3".to_string(),
            bus: 3,
        }];
        let path = std::env::temp_dir().join(format!("bootcan_{}.trc", uuid::Uuid::new_v4()));
        export_trace(
            &path,
            ExportFormat::Trc,
            start_ns,
            &mut frames,
            &buses,
            &HashMap::new(),
        )
        .unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(";$FILEVERSION=2.1"));
        assert!(text.contains(";$COLUMNS=N,O,T,B,I,d,R,L,D"));
        assert!(text.contains("\r\n"));

        let mut map = StdHashMap::new();
        map.insert(3u8, "net-a".to_string());
        let mut player = TracePlayer::new();
        let count = player
            .load_file(path.clone(), Some(map), None)
            .await
            .unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(count, 4);
        let loaded = player.get_all_frames();
        assert_eq!(loaded[0].id, 0x132);
        assert_eq!(loaded[0].direction, "rx");
        assert_eq!(loaded[0].channel, "net-a");
        assert_eq!(
            loaded[0].data,
            vec![0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
        );
        assert_eq!(loaded[1].id, 0x10);
        assert_eq!(loaded[1].direction, "tx");
        let dt = loaded[1].timestamp - loaded[0].timestamp;
        assert!((dt - 0.0015).abs() < 1e-6, "delta was {dt}");
        assert_eq!(loaded[2].id, 0x100);
        assert!(loaded[2].is_extended);
        assert_eq!(loaded[3].id, 0x42);
        assert!(loaded[3].is_remote);
        assert!(loaded[3].data.is_empty());
    }

    #[test]
    fn mcap_contains_canframe_v1_records() {
        let start_ns = 1_700_000_000_000_000_000;
        let mut frames = vec![sample(2_000_000, 0x123, false, false, true, &[0x0A, 0x0B])];
        let buses = vec![TraceBus {
            channel_id: "net-a".to_string(),
            name: "canfd1".to_string(),
            bus: 1,
        }];
        let path = std::env::temp_dir().join(format!("bootcan_{}.mcap", uuid::Uuid::new_v4()));
        export_trace(
            &path,
            ExportFormat::Mcap,
            start_ns,
            &mut frames,
            &buses,
            &HashMap::new(),
        )
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        let mut saw_can = false;
        for message in mcap::MessageStream::new(&bytes).unwrap() {
            let message = message.unwrap();
            assert_eq!(message.channel.topic, "can/0x123");
            assert_eq!(
                message.channel.schema.as_ref().map(|s| s.name.as_str()),
                Some("CanFrameV1")
            );
            let value: serde_json::Value = serde_json::from_slice(&message.data).unwrap();
            assert_eq!(value["arbitration_id"], 0x123);
            assert_eq!(value["is_extended_id"], false);
            assert_eq!(value["is_remote_frame"], false);
            assert_eq!(value["is_fd"], false);
            assert_eq!(value["dlc"], 2);
            assert_eq!(value["data"], serde_json::json!([10, 11]));
            assert!(value.get("direction").is_none());
            assert_eq!(value["ts_ns"], start_ns + 2_000_000);
            assert_eq!(message.log_time, start_ns + 2_000_000);
            saw_can = true;
        }
        assert!(saw_can);
    }

    #[test]
    fn mcap_uses_decoded_topics_when_a_symbol_file_knows_the_id() {
        use crate::core::dbc::{ByteOrder, Message, Signal, ValueType};

        let start_ns = 1_700_000_000_000_000_000;
        let mut frames = vec![
            sample(0, 0x123, false, false, false, &[0x0A]),
            sample(1_000_000, 0x16C, false, false, false, &[0x01]),
            sample(2_000_000, 0x10600404, true, false, false, &[0x02]),
        ];
        let mut db = DbcDatabase::new();
        db.messages.insert(
            0x123,
            Message {
                id: 0x123,
                name: "ALC_Status1".to_string(),
                dlc: 1,
                sender: None,
                signals: vec![Signal {
                    name: "status".to_string(),
                    start_bit: 0,
                    length: 8,
                    byte_order: ByteOrder::LittleEndian,
                    value_type: ValueType::Unsigned,
                    factor: 1.0,
                    offset: 0.0,
                    minimum: None,
                    maximum: None,
                    unit: String::new(),
                    receivers: vec![],
                    comment: None,
                    value_table: None,
                    is_multiplexer: false,
                    multiplex: None,
                }],
                comment: None,
            },
        );
        let mut databases = HashMap::new();
        databases.insert("net-a".to_string(), db);

        let path = std::env::temp_dir().join(format!("bootcan_{}.mcap", uuid::Uuid::new_v4()));
        export_trace(
            &path,
            ExportFormat::Mcap,
            start_ns,
            &mut frames,
            &[],
            &databases,
        )
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);

        let mut topics = Vec::new();
        for message in mcap::MessageStream::new(&bytes).unwrap() {
            let message = message.unwrap();
            let schema = message
                .channel
                .schema
                .as_ref()
                .map(|s| s.name.clone())
                .unwrap_or_default();
            topics.push((message.channel.topic.clone(), schema, message.data.to_vec()));
        }
        assert_eq!(topics[0].0, "can/ALC_Status1");
        assert_eq!(topics[0].1, "DecodedCan_ALC_Status1");
        let decoded: serde_json::Value = serde_json::from_slice(&topics[0].2).unwrap();
        assert_eq!(decoded["_message"], "ALC_Status1");
        assert_eq!(decoded["status"], serde_json::json!(10.0));
        assert_eq!(topics[1].0, "can/0x16C");
        assert_eq!(topics[1].1, "CanFrameV1");
        assert_eq!(topics[2].0, "can/0x10600404");
        assert_eq!(topics[2].1, "CanFrameV1");
    }
}
