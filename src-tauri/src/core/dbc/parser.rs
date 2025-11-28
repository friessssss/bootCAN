use crate::core::dbc::models::*;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

pub struct DbcParser;

impl DbcParser {
    /// Parse a DBC file from a path
    pub fn parse_file<P: AsRef<Path>>(path: P) -> Result<DbcDatabase, String> {
        let content = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read DBC file: {}", e))?;
        Self::parse(&content)
    }

    /// Parse DBC content from a string
    pub fn parse(content: &str) -> Result<DbcDatabase, String> {
        let mut db = DbcDatabase::new();
        let mut current_message_id: Option<u32> = None;
        let mut value_tables: HashMap<String, HashMap<i64, String>> = HashMap::new();

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") {
                continue;
            }

            // Parse VERSION
            if line.starts_with("VERSION") {
                if let Some(version) = Self::parse_version(line) {
                    db.version = Some(version);
                }
            }
            // Parse message: BO_ <id> <name>: <dlc> <sender>
            else if line.starts_with("BO_") {
                if let Some((id, name, dlc, sender)) = Self::parse_message(line) {
                    let message = Message {
                        id,
                        name,
                        dlc,
                        sender,
                        signals: vec![],
                        comment: None,
                    };
                    db.messages.insert(id, message);
                    current_message_id = Some(id);
                }
            }
            // Parse signal: SG_ <name> : <start_bit>|<length>@<byte_order><value_type> (<factor>,<offset>) [<min>|<max>] "<unit>" <receivers>
            else if line.starts_with("SG_") {
                if let Some(signal) = Self::parse_signal(line) {
                    if let Some(msg_id) = current_message_id {
                        if let Some(message) = db.messages.get_mut(&msg_id) {
                            message.signals.push(signal);
                        }
                    }
                }
            }
            // Parse value table: VAL_ <message_id> <signal_name> <value> "<name>" <value> "<name>" ... ;
            else if line.starts_with("VAL_") {
                if let Some((signal_name, values)) = Self::parse_value_table(line) {
                    value_tables.insert(signal_name, values);
                }
            }
            // Parse comment: CM_ BO_ <message_id> "<comment>"; or CM_ SG_ <message_id> <signal_name> "<comment>";
            else if line.starts_with("CM_") {
                Self::parse_comment(line, &mut db, current_message_id);
            }
            // Parse node: BU_: <node1> <node2> ...
            else if line.starts_with("BU_:") {
                db.nodes = Self::parse_nodes(line);
            }
        }

        // Link value tables to signals
        for message in db.messages.values_mut() {
            for signal in message.signals.iter_mut() {
                if let Some(values) = value_tables.remove(&signal.name) {
                    let vt_name = signal.name.clone();
                    db.value_tables.insert(vt_name.clone(), ValueTable {
                        name: vt_name.clone(),
                        values,
                    });
                    signal.value_table = Some(vt_name);
                }
            }
        }

        Ok(db)
    }

    fn parse_version(line: &str) -> Option<String> {
        // VERSION "version_string"
        let re = regex::Regex::new(r#"VERSION\s+"([^"]+)""#).ok()?;
        re.captures(line)?.get(1)?.as_str().to_string().into()
    }

    fn parse_message(line: &str) -> Option<(u32, String, u8, Option<String>)> {
        // BO_ <id> <name>: <dlc> <sender>
        // Example: BO_ 100 EngineSpeed: 8 ECU
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            return None;
        }

        let id = parts[1].parse::<u32>().ok()?;
        let name_with_colon = parts[2];
        let name = name_with_colon.trim_end_matches(':').to_string();
        let dlc = parts[3].parse::<u8>().ok()?;
        let sender = if parts.len() > 4 {
            Some(parts[4].to_string())
        } else {
            None
        };

        Some((id, name, dlc, sender))
    }

    fn parse_signal(line: &str) -> Option<Signal> {
        // SG_ <name> : <start_bit>|<length>@<byte_order><value_type> (<factor>,<offset>) [<min>|<max>] "<unit>" <receivers>
        // Example: SG_ Speed : 0|16@1+ (0.1,0) [0|6553.5] "km/h" ECU
        let re = regex::Regex::new(
            r#"SG_\s+(\w+)\s*:\s*(\d+)\|(\d+)@([01])([+-])\s+\(([^,]+),([^)]+)\)\s*(?:\[([^\]]+)\])?\s*"([^"]*)"\s*(.*)"#
        ).ok()?;

        let caps = re.captures(line)?;
        let name = caps.get(1)?.as_str().to_string();
        let start_bit = caps.get(2)?.as_str().parse::<u8>().ok()?;
        let length = caps.get(3)?.as_str().parse::<u8>().ok()?;
        let byte_order_num = caps.get(4)?.as_str().parse::<u8>().ok()?;
        let byte_order = if byte_order_num == 0 {
            ByteOrder::BigEndian
        } else {
            ByteOrder::LittleEndian
        };
        let value_type_char = caps.get(5)?.as_str();
        let value_type = match value_type_char {
            "+" => ValueType::Unsigned,
            "-" => ValueType::Signed,
            _ => ValueType::Unsigned,
        };
        let factor = caps.get(6)?.as_str().parse::<f64>().ok()?;
        let offset = caps.get(7)?.as_str().parse::<f64>().ok()?;
        
        let (min, max) = if let Some(range) = caps.get(8) {
            let range_str = range.as_str();
            let parts: Vec<&str> = range_str.split('|').collect();
            let min = parts.get(0)?.parse::<f64>().ok();
            let max = parts.get(1)?.parse::<f64>().ok();
            (min, max)
        } else {
            (None, None)
        };

        let unit = caps.get(9)?.as_str().to_string();
        let receivers_str = caps.get(10)?.as_str();
        let receivers: Vec<String> = receivers_str
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();

        Some(Signal {
            name,
            start_bit,
            length,
            byte_order,
            value_type,
            factor,
            offset,
            minimum: min,
            maximum: max,
            unit,
            receivers,
            comment: None,
            value_table: None,
        })
    }

    fn parse_value_table(line: &str) -> Option<(String, HashMap<i64, String>)> {
        // VAL_ <message_id> <signal_name> <value> "<name>" <value> "<name>" ... ;
        // Example: VAL_ 100 Speed 0 "Stopped" 1 "Moving" ;
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 4 {
            return None;
        }

        let signal_name = parts[2].to_string();
        let mut values = HashMap::new();

        let mut i = 3;
        while i + 1 < parts.len() {
            if let Ok(value) = parts[i].parse::<i64>() {
                if i + 1 < parts.len() {
                    let name = parts[i + 1].trim_matches('"').to_string();
                    values.insert(value, name);
                    i += 2;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        Some((signal_name, values))
    }

    fn parse_comment(line: &str, db: &mut DbcDatabase, _current_message_id: Option<u32>) {
        // CM_ BO_ <message_id> "<comment>";
        // CM_ SG_ <message_id> <signal_name> "<comment>";
        if line.contains("BO_") {
            let re = regex::Regex::new(r#"CM_\s+BO_\s+(\d+)\s+"([^"]+)";"#).ok();
            if let Some(caps) = re.and_then(|r| r.captures(line)) {
                if let (Some(id_str), Some(comment)) = (caps.get(1), caps.get(2)) {
                    if let Ok(id) = id_str.as_str().parse::<u32>() {
                        if let Some(message) = db.messages.get_mut(&id) {
                            message.comment = Some(comment.as_str().to_string());
                        }
                    }
                }
            }
        } else if line.contains("SG_") {
            let re = regex::Regex::new(r#"CM_\s+SG_\s+(\d+)\s+(\w+)\s+"([^"]+)";"#).ok();
            if let Some(caps) = re.and_then(|r| r.captures(line)) {
                if let (Some(id_str), Some(signal_name), Some(comment)) = 
                    (caps.get(1), caps.get(2), caps.get(3)) {
                    if let Ok(id) = id_str.as_str().parse::<u32>() {
                        if let Some(message) = db.messages.get_mut(&id) {
                            if let Some(signal) = message.signals.iter_mut()
                                .find(|s| s.name == signal_name.as_str()) {
                                signal.comment = Some(comment.as_str().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    fn parse_nodes(line: &str) -> Vec<String> {
        // BU_: <node1> <node2> ...
        line.trim_start_matches("BU_:")
            .split_whitespace()
            .map(|s| s.to_string())
            .collect()
    }
}

