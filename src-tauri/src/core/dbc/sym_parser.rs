use crate::core::dbc::models::*;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// Parser for PCAN Symbol files (.sym format)
pub struct SymParser;

impl SymParser {
    /// Parse a SYM file from a path
    pub fn parse_file<P: AsRef<Path>>(path: P) -> Result<DbcDatabase, String> {
        let content = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read SYM file: {}", e))?;
        Self::parse(&content)
    }

    /// Parse SYM content from a string
    pub fn parse(content: &str) -> Result<DbcDatabase, String> {
        let mut db = DbcDatabase::new();
        let mut signal_definitions: HashMap<String, Signal> = HashMap::new();
        let mut value_tables: HashMap<String, HashMap<i64, String>> = HashMap::new();
        let mut current_message_id: Option<u32> = None;
        let mut current_message_name: Option<String> = None;
        let mut current_message_dlc: Option<u8> = None;
        let mut current_message_extended: bool = false;
        let mut in_signals_section = false;
        let mut in_sendreceive_section = false;

        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("//") {
                continue;
            }

            // Section markers
            if line == "{SIGNALS}" {
                in_signals_section = true;
                in_sendreceive_section = false;
                continue;
            } else if line == "{SENDRECEIVE}" {
                in_signals_section = false;
                in_sendreceive_section = true;
                continue;
            } else if line.starts_with('{') {
                in_signals_section = false;
                in_sendreceive_section = false;
            }

            // Parse FormatVersion
            if line.starts_with("FormatVersion=") {
                if let Some(version) = line.split('=').nth(1) {
                    db.version = Some(version.trim().to_string());
                }
            }
            // Parse Enum definitions: enum Name(value="Name", ...) or Enum=name(value="Name", ...)
            else if line.starts_with("enum ") || line.starts_with("Enum=") {
                if let Some((name, values)) = Self::parse_enum(line) {
                    value_tables.insert(name, values);
                }
            }
            // Parse Signal definition in {SIGNALS} section: Sig=name type bits /u:unit /f:factor /o:offset /e:enum
            else if in_signals_section && line.starts_with("Sig=") {
                if let Some(signal) = Self::parse_signal(line) {
                    signal_definitions.insert(signal.name.clone(), signal);
                }
            }
            // Parse Message definition header: [MessageName] (can be on separate lines)
            else if in_sendreceive_section && line.starts_with("[") && line.contains("]") {
                // Extract message name from [MessageName]
                if let Some(name_end) = line.find(']') {
                    let name = line[1..name_end].to_string();
                    current_message_name = Some(name);
                    current_message_id = None;
                    current_message_dlc = None;
                    current_message_extended = false; // Reset extended flag for new message
                }
            }
            // Parse Type=Extended or Type=Standard
            else if in_sendreceive_section && current_message_name.is_some() && line.starts_with("Type=") {
                if let Some(type_part) = line.split("Type=").nth(1) {
                    let msg_type = type_part.split_whitespace().next().unwrap_or("").trim();
                    current_message_extended = msg_type.eq_ignore_ascii_case("Extended");
                }
            }
            // Parse ID=xxxh (part of message header)
            else if in_sendreceive_section && current_message_name.is_some() && line.starts_with("ID=") {
                if let Some(id_part) = line.split("ID=").nth(1) {
                    if let Some(id_str) = id_part.split_whitespace().next() {
                        let id_str = id_str.trim_end_matches('h');
                        if let Ok(id) = u32::from_str_radix(id_str, 16) {
                            current_message_id = Some(id);
                            // Try to create message if we have all required fields
                            Self::try_create_message(
                                &mut db,
                                &mut current_message_name,
                                &mut current_message_id,
                                &mut current_message_dlc,
                                &mut current_message_extended,
                            );
                        }
                    }
                }
            }
            // Parse DLC=x or Len=x (part of message header)
            else if in_sendreceive_section && current_message_name.is_some() && (line.starts_with("DLC=") || line.starts_with("Len=")) {
                let prefix = if line.starts_with("DLC=") { "DLC=" } else { "Len=" };
                if let Some(dlc_part) = line.split(prefix).nth(1) {
                    if let Some(dlc_str) = dlc_part.split_whitespace().next() {
                        if let Ok(dlc) = dlc_str.parse::<u8>() {
                            current_message_dlc = Some(dlc);
                            // Try to create message if we have all required fields
                            Self::try_create_message(
                                &mut db,
                                &mut current_message_name,
                                &mut current_message_id,
                                &mut current_message_dlc,
                                &mut current_message_extended,
                            );
                        }
                    }
                }
            }
            // Parse signal assignment in message: Sig=signalName bit_position
            else if in_sendreceive_section && current_message_id.is_some() && line.starts_with("Sig=") {
                if let Some((signal_name, bit_pos)) = Self::parse_signal_assignment(line) {
                    if let Some(mut signal) = signal_definitions.get(&signal_name).cloned() {
                        signal.start_bit = bit_pos;
                        if let Some(message) = db.messages.get_mut(&current_message_id.unwrap()) {
                            message.signals.push(signal);
                        }
                    }
                }
            }
            // Parse variable assignment: Var=name type bit,length /u:unit /f:factor /o:offset /e:enum /d:default /max:max /min:min
            else if in_sendreceive_section && current_message_id.is_some() && line.starts_with("Var=") {
                if let Some(signal) = Self::parse_variable(line) {
                    if let Some(message) = db.messages.get_mut(&current_message_id.unwrap()) {
                        message.signals.push(signal);
                    }
                }
            }
        }

        // Link value tables to signals (by enum name, not signal name)
        for message in db.messages.values_mut() {
            for signal in message.signals.iter_mut() {
                if let Some(ref enum_name) = signal.value_table {
                    if value_tables.contains_key(enum_name) {
                        let values = value_tables.remove(enum_name).unwrap();
                        let enum_name_clone = enum_name.clone();
                        db.value_tables.insert(enum_name_clone.clone(), ValueTable {
                            name: enum_name_clone.clone(),
                            values,
                        });
                        signal.value_table = Some(enum_name_clone);
                    }
                }
            }
        }

        Ok(db)
    }

    fn parse_enum(line: &str) -> Option<(String, HashMap<i64, String>)> {
        // enum Name(value="Name", value2="Name2", ...) or Enum=name(value="Name", ...)
        let line_trimmed = if line.starts_with("enum ") {
            &line[5..] // Skip "enum "
        } else if line.starts_with("Enum=") {
            &line[5..] // Skip "Enum="
        } else {
            return None;
        };

        // Find the opening parenthesis
        if let Some(open_paren) = line_trimmed.find('(') {
            let name = line_trimmed[..open_paren].trim().to_string();
            let values_str = if let Some(close_paren) = line_trimmed.rfind(')') {
                &line_trimmed[open_paren + 1..close_paren]
            } else {
                return None;
            };

            let mut values = HashMap::new();

            // Parse value="Name" pairs
            // Format: 97="SEP2 VTG Discharging", 96="CAN VTG Discharging", ...
            let re = regex::Regex::new(r#"(\d+)="([^"]+)""#).ok()?;
            for cap in re.captures_iter(values_str) {
                if let (Some(value_str), Some(name_str)) = (cap.get(1), cap.get(2)) {
                    if let Ok(value) = value_str.as_str().parse::<i64>() {
                        values.insert(value, name_str.as_str().to_string());
                    }
                }
            }

            Some((name, values))
        } else {
            None
        }
    }

    fn parse_signal(line: &str) -> Option<Signal> {
        // Sig=name type bits /u:unit /f:factor /o:offset /e:enum /max:max /min:min
        // Example: Sig=temp_Cabin_VCU unsigned 10 /u:C /f:0.1 /o:-40
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            return None;
        }

        let name = parts[0].trim_start_matches("Sig=").to_string();
        let signal_type = parts[1];
        let length_str = parts[2];

        let (value_type, length) = match signal_type {
            "unsigned" => (ValueType::Unsigned, length_str.parse::<u8>().ok()?),
            "signed" => (ValueType::Signed, length_str.parse::<u8>().ok()?),
            "float" => (ValueType::Float, 32),
            "double" => (ValueType::Double, 64),
            _ => (ValueType::Unsigned, length_str.parse::<u8>().ok()?),
        };

        let mut factor = 1.0;
        let mut offset = 0.0;
        let mut unit = String::new();
        let mut min_val = None;
        let mut max_val = None;
        let mut value_table_name = None;

        // Parse attributes
        for part in parts.iter().skip(3) {
            if part.starts_with("/f:") {
                factor = part.trim_start_matches("/f:").parse::<f64>().unwrap_or(1.0);
            } else if part.starts_with("/o:") {
                offset = part.trim_start_matches("/o:").parse::<f64>().unwrap_or(0.0);
            } else if part.starts_with("/u:") {
                unit = part.trim_start_matches("/u:").to_string();
            } else if part.starts_with("/e:") {
                value_table_name = Some(part.trim_start_matches("/e:").to_string());
            } else if part.starts_with("/max:") {
                max_val = part.trim_start_matches("/max:").parse::<f64>().ok();
            } else if part.starts_with("/min:") {
                min_val = part.trim_start_matches("/min:").parse::<f64>().ok();
            }
        }

        Some(Signal {
            name,
            start_bit: 0, // Will be set from message assignment
            length,
            byte_order: ByteOrder::LittleEndian, // SYM files typically use little-endian
            value_type,
            factor,
            offset,
            minimum: min_val,
            maximum: max_val,
            unit,
            receivers: vec![],
            comment: None,
            value_table: value_table_name,
        })
    }

    fn try_create_message(
        db: &mut DbcDatabase,
        name: &mut Option<String>,
        id: &mut Option<u32>,
        dlc: &mut Option<u8>,
        extended: &mut bool,
    ) {
        // Only create message if we have all three required fields
        if name.is_some() && id.is_some() && dlc.is_some() {
            let message_name = name.take().unwrap();
            let message_id = id.take().unwrap();
            let message_dlc = dlc.take().unwrap();
            
            // If extended flag is set, ensure ID is treated as extended
            // (The ID itself should already be correct, but we can verify)
            let final_id = if *extended && message_id <= 0x7FF {
                // If Type=Extended but ID looks standard, keep as-is (might be a low extended ID)
                message_id
            } else {
                message_id
            };
            
            let message = Message {
                id: final_id,
                name: message_name,
                dlc: message_dlc,
                sender: None,
                signals: vec![],
                comment: None,
            };
            db.messages.insert(final_id, message);
            // Restore id for signal parsing
            *id = Some(final_id);
            *extended = false; // Reset for next message
        }
    }

    fn parse_signal_assignment(line: &str) -> Option<(String, u8)> {
        // Sig=signalName bit_position
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            return None;
        }

        let signal_name = parts[0].trim_start_matches("Sig=").to_string();
        let bit_pos = parts[1].parse::<u8>().ok()?;

        Some((signal_name, bit_pos))
    }

    fn parse_variable(line: &str) -> Option<Signal> {
        // Var=name type bit,length /u:unit /f:factor /o:offset /e:enum /d:default /max:max /min:min
        // Example: Var=V2BCMDLifeSignal unsigned 0,8 /e:VtSig_V2BCMDLifeSignal
        // Example: Var=B2VST2SOC unsigned 0,8 /u:% /f:0.4 /max:100 /e:VtSig_V2BCMDLifeSignal /d:0
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            return None;
        }

        let var_name = parts[0].trim_start_matches("Var=").to_string();
        let signal_type = parts[1];
        
        let bit_length = parts[2];
        let bit_length_parts: Vec<&str> = bit_length.split(',').collect();
        let bit_pos = bit_length_parts[0].parse::<u8>().ok()?;
        let length = bit_length_parts.get(1).and_then(|s| s.parse::<u8>().ok())?;

        let value_type = match signal_type {
            "unsigned" => ValueType::Unsigned,
            "signed" => ValueType::Signed,
            "float" => ValueType::Float,
            "double" => ValueType::Double,
            "bit" => ValueType::Unsigned, // Treat bit as unsigned
            _ => ValueType::Unsigned,
        };

        let mut factor = 1.0;
        let mut offset = 0.0;
        let mut unit = String::new();
        let mut min_val = None;
        let mut max_val = None;
        let mut enum_name = None;
        let mut _default_val = None; // Default value (not used in decoding, but parsed for completeness)

        // Parse attributes
        for part in parts.iter().skip(3) {
            if part.starts_with("/f:") {
                factor = part.trim_start_matches("/f:").parse::<f64>().unwrap_or(1.0);
            } else if part.starts_with("/o:") {
                offset = part.trim_start_matches("/o:").parse::<f64>().unwrap_or(0.0);
            } else if part.starts_with("/u:") {
                unit = part.trim_start_matches("/u:").to_string();
            } else if part.starts_with("/e:") {
                enum_name = Some(part.trim_start_matches("/e:").to_string());
            } else if part.starts_with("/d:") {
                _default_val = part.trim_start_matches("/d:").parse::<f64>().ok();
            } else if part.starts_with("/max:") {
                max_val = part.trim_start_matches("/max:").parse::<f64>().ok();
            } else if part.starts_with("/min:") {
                min_val = part.trim_start_matches("/min:").parse::<f64>().ok();
            }
        }

        Some(Signal {
            name: var_name,
            start_bit: bit_pos,
            length,
            byte_order: ByteOrder::LittleEndian, // SYM files typically use little-endian
            value_type,
            factor,
            offset,
            minimum: min_val,
            maximum: max_val,
            unit,
            receivers: vec![],
            comment: None,
            value_table: enum_name,
        })
    }
}

