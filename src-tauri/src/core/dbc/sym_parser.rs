use crate::core::dbc::models::*;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

/// Parser for PCAN Symbol files (.sym format).
///
/// PEAK symbol files group frames under `{SEND}`, `{RECEIVE}`, and
/// `{SENDRECEIVE}`. Signal templates live in `{SIGNALS}` and are placed into
/// frames with `Sig=<name> <startbit>`. Frames can also define signals inline
/// with `Var=`. Enums in `{ENUMS}` may wrap across lines.
pub struct SymParser;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    Other,
    Enums,
    Signals,
    Messages,
}

struct OpenMessage {
    name: String,
    ids: Vec<u32>,
    dlc: Option<u8>,
    signals: Vec<Signal>,
    /// Raw multiplex value for signals added from the current page.
    mux_value: Option<u64>,
    mux_labels: Vec<(u64, String)>,
    mux_table: Option<String>,
}

struct TypeInfo {
    value_type: ValueType,
    /// Length implied by the type when the file omits it (`bit`, `float`, `double`).
    default_length: Option<u8>,
    /// Set when the type token is an enum name rather than a builtin.
    enum_name: Option<String>,
}

struct Attrs {
    factor: f64,
    offset: f64,
    unit: String,
    minimum: Option<f64>,
    maximum: Option<f64>,
    value_table: Option<String>,
    byte_order: ByteOrder,
}

impl SymParser {
    /// Parse a SYM file from a path
    pub fn parse_file<P: AsRef<Path>>(path: P) -> Result<DbcDatabase, String> {
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read SYM file: {}", e))?;
        Self::parse(&content)
    }

    /// Parse SYM content from a string
    pub fn parse(content: &str) -> Result<DbcDatabase, String> {
        let mut db = DbcDatabase::new();
        let enum_re = regex::Regex::new(r#"(-?\d+)\s*=\s*"([^"]*)""#)
            .map_err(|e| format!("Failed to compile enum pattern: {}", e))?;

        let mut section = Section::Other;
        let mut pending_enum: Option<String> = None;
        let mut signal_defs: HashMap<String, Signal> = HashMap::new();
        let mut open: Option<OpenMessage> = None;

        for raw_line in content.lines() {
            let line = strip_comment(raw_line);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            if pending_enum.is_some() && !is_enum_start(line) && !line.starts_with('{') {
                let buf = pending_enum.as_mut().expect("pending enum");
                buf.push(' ');
                buf.push_str(line);
                if buf.contains(')') {
                    let finished = pending_enum.take().expect("pending enum");
                    if let Some((name, values)) = parse_enum(&finished, &enum_re) {
                        insert_enum(&mut db, name, values);
                    }
                }
                continue;
            }
            // A new enum or section means the previous one never closed.
            pending_enum = None;

            if let Some(next) = section_kind(line) {
                commit(&mut db, open.take());
                section = next;
                continue;
            }

            match section {
                Section::Enums => {
                    if is_enum_start(line) {
                        if line.contains(')') {
                            if let Some((name, values)) = parse_enum(line, &enum_re) {
                                insert_enum(&mut db, name, values);
                            }
                        } else if line.contains('(') {
                            pending_enum = Some(line.to_string());
                        }
                    }
                }
                Section::Signals => {
                    if let Some(rest) = line.strip_prefix("Sig=") {
                        let tokens = split_ws_quotes(rest);
                        if let Some(signal) = parse_signal_tokens(&tokens, false) {
                            signal_defs.insert(signal.name.clone(), signal);
                        }
                    }
                }
                Section::Messages => {
                    if line.starts_with('[') && line.ends_with(']') {
                        if let Some(name) = frame_name(line) {
                            // PEAK repeats `[Name]` once per multiplex page. Later
                            // pages omit the ID and belong to the message already open.
                            let continuation = open.as_ref().is_some_and(|msg| msg.name == name);
                            if continuation {
                                if let Some(msg) = open.as_mut() {
                                    msg.mux_value = None;
                                }
                            } else {
                                commit(&mut db, open.take());
                                open = Some(OpenMessage {
                                    name,
                                    ids: Vec::new(),
                                    dlc: None,
                                    signals: Vec::new(),
                                    mux_value: None,
                                    mux_labels: Vec::new(),
                                    mux_table: None,
                                });
                            }
                        }
                        continue;
                    }

                    let Some(msg) = open.as_mut() else {
                        continue;
                    };

                    if let Some(rest) = line.strip_prefix("ID=") {
                        if msg.ids.is_empty() {
                            if let Some(ids) = parse_id_list(rest) {
                                msg.ids = ids;
                            }
                        }
                    } else if let Some(rest) = strip_any_prefix(line, &["Len=", "DLC="]) {
                        if let Some(dlc) =
                            rest.split_whitespace().next().and_then(|s| s.parse().ok())
                        {
                            msg.dlc = Some(dlc);
                        }
                    } else if let Some(rest) = line.strip_prefix("Mux=") {
                        let tokens = split_ws_quotes(rest);
                        if let Some(mux) = parse_mux(&tokens) {
                            apply_mux(msg, mux);
                        }
                    } else if let Some(rest) = line.strip_prefix("Sig=") {
                        let tokens = split_ws_quotes(rest);
                        if let Some((name, start_bit)) = parse_assignment(&tokens) {
                            if let Some(mut signal) = signal_defs.get(&name).cloned() {
                                signal.start_bit = placed_start_bit(start_bit, signal.byte_order);
                                push_signal(msg, signal);
                            }
                        }
                    } else if let Some(rest) = line.strip_prefix("Var=") {
                        let tokens = split_ws_quotes(rest);
                        if let Some(signal) = parse_signal_tokens(&tokens, true) {
                            push_signal(msg, signal);
                        }
                    }
                }
                Section::Other => {
                    if let Some(version) = line.strip_prefix("FormatVersion=") {
                        db.version = Some(version.trim().to_string());
                    }
                }
            }
        }

        if let Some(buf) = pending_enum {
            if let Some((name, values)) = parse_enum(&buf, &enum_re) {
                insert_enum(&mut db, name, values);
            }
        }
        commit(&mut db, open.take());

        Ok(db)
    }
}

fn insert_enum(db: &mut DbcDatabase, name: String, values: HashMap<i64, String>) {
    db.value_tables
        .insert(name.clone(), ValueTable { name, values });
}

fn commit(db: &mut DbcDatabase, open: Option<OpenMessage>) {
    let Some(open) = open else {
        return;
    };
    let Some(dlc) = open.dlc else {
        return;
    };
    if open.ids.is_empty() {
        return;
    }
    if let Some(table) = &open.mux_table {
        let mut values = HashMap::new();
        for (value, label) in &open.mux_labels {
            if let Ok(key) = i64::try_from(*value) {
                values.insert(key, label.clone());
            }
        }
        db.value_tables.insert(
            table.clone(),
            ValueTable {
                name: table.clone(),
                values,
            },
        );
    }
    for id in open.ids {
        db.messages.insert(
            id,
            Message {
                id,
                name: open.name.clone(),
                dlc,
                sender: None,
                signals: open.signals.clone(),
                comment: None,
            },
        );
    }
}

fn section_kind(line: &str) -> Option<Section> {
    let inner = line.strip_prefix('{')?.strip_suffix('}')?.trim();
    Some(match inner.to_ascii_uppercase().as_str() {
        "ENUMS" => Section::Enums,
        "SIGNALS" => Section::Signals,
        "SEND" | "RECEIVE" | "SENDRECEIVE" => Section::Messages,
        _ => Section::Other,
    })
}

fn is_enum_start(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.starts_with("enum=") || lower.starts_with("enum ")
}

fn frame_name(line: &str) -> Option<String> {
    let inner = line.strip_prefix('[')?.strip_suffix(']')?.trim();
    let name = inner.trim_matches('"').trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// `1C0h`, `18FF50E5h`, or an inclusive range `640h-643h`.
///
/// A span wider than 4096 IDs is kept as the start ID only, so a corrupt
/// range cannot explode the message map.
fn parse_id_list(rest: &str) -> Option<Vec<u32>> {
    let token = rest.split_whitespace().next()?;
    if let Some((start_tok, end_tok)) = token.split_once('-') {
        let start = parse_hex_id(start_tok)?;
        let end = parse_hex_id(end_tok)?;
        if end < start {
            return None;
        }
        if end - start > 4096 {
            return Some(vec![start]);
        }
        Some((start..=end).collect())
    } else {
        Some(vec![parse_hex_id(token)?])
    }
}

fn parse_hex_id(token: &str) -> Option<u32> {
    let token = token.trim();
    let token = token
        .strip_suffix('h')
        .or_else(|| token.strip_suffix('H'))
        .unwrap_or(token);
    if token.is_empty() {
        None
    } else {
        u32::from_str_radix(token, 16).ok()
    }
}

fn parse_assignment(tokens: &[String]) -> Option<(String, u8)> {
    if tokens.len() < 2 {
        return None;
    }
    let start_bit = tokens[1].parse().ok()?;
    Some((tokens[0].clone(), start_bit))
}

fn classify_type(label: &str) -> TypeInfo {
    match label {
        "unsigned" | "raw" | "char" | "string" => TypeInfo {
            value_type: ValueType::Unsigned,
            default_length: None,
            enum_name: None,
        },
        "signed" => TypeInfo {
            value_type: ValueType::Signed,
            default_length: None,
            enum_name: None,
        },
        "bit" => TypeInfo {
            value_type: ValueType::Unsigned,
            default_length: Some(1),
            enum_name: None,
        },
        "float" => TypeInfo {
            value_type: ValueType::Float,
            default_length: Some(32),
            enum_name: None,
        },
        "double" => TypeInfo {
            value_type: ValueType::Double,
            default_length: Some(64),
            enum_name: None,
        },
        other => TypeInfo {
            value_type: ValueType::Unsigned,
            default_length: None,
            enum_name: Some(other.to_string()),
        },
    }
}

/// `positioned` is true for `Var=` lines (`start,length` instead of a bare length).
fn parse_signal_tokens(tokens: &[String], positioned: bool) -> Option<Signal> {
    if tokens.len() < 2 {
        return None;
    }
    let name = tokens[0].clone();
    let info = classify_type(&tokens[1]);
    let mut index = 2usize;

    let (start_bit, length) = if positioned {
        let (start, length) = parse_start_len(tokens.get(index)?)?;
        index += 1;
        (start, length)
    } else if let Some(default_length) = info.default_length {
        if let Some(explicit) = tokens.get(index).and_then(|tok| {
            if tok.chars().all(|c| c.is_ascii_digit()) {
                tok.parse::<u8>().ok()
            } else {
                None
            }
        }) {
            index += 1;
            (0, explicit)
        } else {
            (0, default_length)
        }
    } else {
        let length = tokens.get(index)?.parse().ok()?;
        index += 1;
        (0, length)
    };

    let mut attrs = Attrs {
        factor: 1.0,
        offset: 0.0,
        unit: String::new(),
        minimum: None,
        maximum: None,
        value_table: info.enum_name,
        byte_order: ByteOrder::LittleEndian,
    };
    for part in tokens.iter().skip(index) {
        apply_attr(&mut attrs, part);
    }

    // `Var=` start bits are only converted once `-m` is known. Signal
    // templates get their real start bit later, from the frame assignment.
    let start_bit = if positioned {
        placed_start_bit(start_bit, attrs.byte_order)
    } else {
        start_bit
    };

    Some(Signal {
        name,
        start_bit,
        length,
        byte_order: attrs.byte_order,
        value_type: info.value_type,
        factor: attrs.factor,
        offset: attrs.offset,
        minimum: attrs.minimum,
        maximum: attrs.maximum,
        unit: attrs.unit,
        receivers: vec![],
        comment: None,
        value_table: attrs.value_table,
        is_multiplexer: false,
        multiplex: None,
    })
}

fn push_signal(msg: &mut OpenMessage, mut signal: Signal) {
    signal.multiplex = msg.mux_value;
    msg.signals.push(signal);
}

struct MuxSpec {
    label: String,
    start: u8,
    length: u8,
    value: u64,
    byte_order: ByteOrder,
}

/// `Mux=Name start,length value`, with value decimal or hex (`010000h`).
fn parse_mux(tokens: &[String]) -> Option<MuxSpec> {
    if tokens.len() < 3 {
        return None;
    }
    let (start, length) = parse_start_len(&tokens[1])?;
    let value = parse_mux_value(&tokens[2])?;
    let mut byte_order = ByteOrder::LittleEndian;
    for part in tokens.iter().skip(3) {
        if part == "-m" {
            byte_order = ByteOrder::BigEndian;
        } else if part == "-i" {
            byte_order = ByteOrder::LittleEndian;
        }
    }
    Some(MuxSpec {
        label: tokens[0].clone(),
        start,
        length,
        value,
        byte_order,
    })
}

fn parse_mux_value(token: &str) -> Option<u64> {
    if let Some(hex) = token.strip_suffix('h').or_else(|| token.strip_suffix('H')) {
        if hex.is_empty() {
            None
        } else {
            u64::from_str_radix(hex, 16).ok()
        }
    } else {
        token.parse().ok()
    }
}

fn apply_mux(msg: &mut OpenMessage, mux: MuxSpec) {
    if msg.mux_table.is_none() {
        let table = format!("{}__mux", msg.name);
        msg.signals.insert(
            0,
            Signal {
                name: format!("{} MUX", msg.name),
                start_bit: placed_start_bit(mux.start, mux.byte_order),
                length: mux.length,
                byte_order: mux.byte_order,
                value_type: ValueType::Unsigned,
                factor: 1.0,
                offset: 0.0,
                minimum: None,
                maximum: None,
                unit: String::new(),
                receivers: vec![],
                comment: None,
                value_table: Some(table.clone()),
                is_multiplexer: true,
                multiplex: None,
            },
        );
        msg.mux_table = Some(table);
    }
    msg.mux_value = Some(mux.value);
    msg.mux_labels.push((mux.value, mux.label));
}

/// SYM `-m` start bits use MSB-first numbering inside each byte (bit 0 is
/// the high bit). The decoder uses DBC numbering, where bit 0 is the low bit.
fn placed_start_bit(start_bit: u8, byte_order: ByteOrder) -> u8 {
    match byte_order {
        ByteOrder::LittleEndian => start_bit,
        ByteOrder::BigEndian => {
            let start = u16::from(start_bit);
            let converted = start - (start % 8) + 7 - (start % 8);
            converted as u8
        }
    }
}

fn parse_start_len(token: &str) -> Option<(u8, u8)> {
    let (start, length) = token.split_once(',')?;
    Some((start.trim().parse().ok()?, length.trim().parse().ok()?))
}

fn apply_attr(attrs: &mut Attrs, part: &str) {
    if part == "-m" {
        attrs.byte_order = ByteOrder::BigEndian;
    } else if part == "-i" {
        attrs.byte_order = ByteOrder::LittleEndian;
    } else if let Some(value) = part.strip_prefix("/f:") {
        // PEAK writes `/f:0` when no scale was set. A zero factor would force
        // every physical value to the offset, so treat it as 1.
        let parsed = value.parse::<f64>().unwrap_or(1.0);
        attrs.factor = if parsed == 0.0 { 1.0 } else { parsed };
    } else if let Some(value) = part.strip_prefix("/o:") {
        attrs.offset = value.parse().unwrap_or(0.0);
    } else if let Some(value) = part.strip_prefix("/u:") {
        attrs.unit = value.trim_matches('"').to_string();
    } else if let Some(value) = part.strip_prefix("/e:") {
        let name = value.trim_matches('"');
        if !name.is_empty() {
            attrs.value_table = Some(name.to_string());
        }
    } else if let Some(value) = part.strip_prefix("/min:") {
        attrs.minimum = value.parse().ok();
    } else if let Some(value) = part.strip_prefix("/max:") {
        attrs.maximum = value.parse().ok();
    }
    // -h, -b, -d, /p:, /d:, and /ln: are display-only and do not change decoding.
}

fn parse_enum(line: &str, re: &regex::Regex) -> Option<(String, HashMap<i64, String>)> {
    let rest = if let Some(rest) = strip_any_prefix(line, &["Enum=", "enum=", "Enum ", "enum "]) {
        rest
    } else {
        let lower_prefix = line.to_ascii_lowercase();
        if lower_prefix.starts_with("enum=") {
            &line[5..]
        } else if lower_prefix.starts_with("enum ") {
            &line[5..]
        } else {
            return None;
        }
    };

    let open = rest.find('(')?;
    let name = rest[..open].trim().to_string();
    if name.is_empty() {
        return None;
    }
    let close = rest.rfind(')')?;
    if close < open {
        return None;
    }
    let body = &rest[open + 1..close];

    let mut values = HashMap::new();
    for cap in re.captures_iter(body) {
        let raw = cap.get(1)?.as_str().parse::<i64>().ok()?;
        let label = cap.get(2)?.as_str().to_string();
        values.insert(raw, label);
    }
    Some((name, values))
}

fn strip_any_prefix<'a>(line: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    prefixes.iter().find_map(|prefix| line.strip_prefix(prefix))
}

/// Split on whitespace, keeping quoted spans (including their internal spaces)
/// as a single token. Quote characters themselves are discarded.
fn split_ws_quotes(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for ch in input.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Drop a `//` comment that is not inside quotes.
fn strip_comment(line: &str) -> String {
    let mut out = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '"' {
            in_quotes = !in_quotes;
        }
        if !in_quotes && ch == '/' && chars.peek() == Some(&'/') {
            break;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::SymParser;
    use crate::core::dbc::ByteOrder;

    fn decoded<'a>(
        signals: &'a [crate::core::dbc::DecodedSignal],
        name: &str,
    ) -> &'a crate::core::dbc::DecodedSignal {
        signals.iter().find(|s| s.name == name).expect(name)
    }

    #[test]
    fn parses_receive_section_bit_signals_and_wrapped_enums() {
        let sym = r#"
FormatVersion=6.0 // Do not edit this line!
{ENUMS}
Enum=PDS_ModeOfOperation(0="No mode change/no mode assigned", 1="Profile Position Mode", 2="Velocity Mode",
  3="Profile Velocity mode", 4="Torque profile mode")
Enum=VtSig_Fault(0="NoFault", 16="BuckModFault",
  8="CANLoss")
{SIGNALS}
Sig=status_fault bit
Sig=status_ready bit
Sig=status_ModeOfOp PDS_ModeOfOperation 8
Sig=status_Temp signed 32 /min:-200 /max:200
{RECEIVE}
[Status1]
ID=1C0h
Len=2
Sig=status_ready 0
Sig=status_fault 3
[Status2]
ID=2C0h
Len=5
Sig=status_ModeOfOp 0
Sig=status_Temp 8
{SEND}
[Cmd]
ID=240h
Len=2
Sig=status_ready 0
"#;

        let db = SymParser::parse(sym).unwrap();
        assert_eq!(db.version.as_deref(), Some("6.0"));
        assert_eq!(db.value_tables["PDS_ModeOfOperation"].values.len(), 5);
        assert_eq!(
            db.value_tables["VtSig_Fault"]
                .values
                .get(&8)
                .map(String::as_str),
            Some("CANLoss")
        );

        let status1 = db.get_message(0x1C0).unwrap();
        assert_eq!(status1.signals.len(), 2);
        assert!(status1.signals.iter().all(|s| s.length == 1));

        let bits = db.decode_message(0x1C0, &[0x09]);
        assert_eq!(decoded(&bits, "status_ready").physical_value, 1.0);
        assert_eq!(decoded(&bits, "status_fault").physical_value, 1.0);

        let mode = db.decode_message(0x2C0, &[1, 25, 0, 0, 0]);
        assert_eq!(
            decoded(&mode, "status_ModeOfOp").value_name.as_deref(),
            Some("Profile Position Mode")
        );
        assert_eq!(decoded(&mode, "status_Temp").physical_value, 25.0);

        // The same enum is attached to every signal that names it.
        let cmd = db.decode_message(0x240, &[0x01]);
        assert_eq!(decoded(&cmd, "status_ready").physical_value, 1.0);
        assert_eq!(
            db.get_message(0x2C0).unwrap().signals[0]
                .value_table
                .as_deref(),
            Some("PDS_ModeOfOperation")
        );
    }

    #[test]
    fn parses_id_ranges_quoted_names_and_inline_enum_vars() {
        let sym = r#"
{ENUMS}
Enum=PDS_OBJECT_DICT_INDEX(25602="MOTOR_TYPE", 24672="MODE_OF_OP")
{RECEIVE}
["Crouzet SDO Download"]
ID=640h-643h
Len=8
Var=Index PDS_OBJECT_DICT_INDEX 8,16 -b /p:0
Var="data size specified" unsigned 0,1
Var=Subindex unsigned 24,8 -h /max:1
"#;

        let db = SymParser::parse(sym).unwrap();
        for id in 0x640..=0x643 {
            let msg = db.get_message(id).unwrap();
            assert_eq!(msg.name, "Crouzet SDO Download");
            assert!(msg.signals.iter().any(|s| s.name == "data size specified"));
            let index = msg.signals.iter().find(|s| s.name == "Index").unwrap();
            assert_eq!(index.start_bit, 8);
            assert_eq!(index.length, 16);
            assert_eq!(index.byte_order, ByteOrder::LittleEndian);
            assert_eq!(index.value_table.as_deref(), Some("PDS_OBJECT_DICT_INDEX"));
        }

        let signals = db.decode_message(0x642, &[0x00, 0x60, 0x60, 0x00, 0, 0, 0, 0]);
        let index = signals.iter().find(|s| s.name == "Index").unwrap();
        assert_eq!(index.raw_value, 24672);
        assert_eq!(index.value_name.as_deref(), Some("MODE_OF_OP"));
        assert_eq!(decoded(&signals, "data size specified").physical_value, 0.0);
    }

    #[test]
    fn parses_sendreceive_scaling_and_motorola() {
        let sym = r#"
{ENUMS}
Enum=VtSig_PrechargeReq(0="Deactivate Precharge", 1="Activate Precharge")
{SENDRECEIVE}
[Scaled]
ID=100h
DLC=2
Var=temp unsigned 0,8 /u:C /f:0.1 /o:-40
[Version]
ID=5A0h
Len=8
Var=SwVerMajor unsigned 0,8 -m
[Ctrl]
ID=2B0h
Len=1
Var=PrechargeReq bit 3,1 -m /e:VtSig_PrechargeReq
"#;

        let db = SymParser::parse(sym).unwrap();
        let temp = db.decode_message(0x100, &[100]);
        assert_eq!(decoded(&temp, "temp").physical_value, -30.0);
        assert_eq!(decoded(&temp, "temp").unit, "C");

        let ver = db.decode_message(0x5A0, &[0x0A]);
        assert_eq!(decoded(&ver, "SwVerMajor").physical_value, 10.0);
        assert_eq!(
            db.get_message(0x5A0).unwrap().signals[0].byte_order,
            ByteOrder::BigEndian
        );

        let ctrl = db.decode_message(0x2B0, &[0x10]);
        assert_eq!(
            decoded(&ctrl, "PrechargeReq").value_name.as_deref(),
            Some("Activate Precharge")
        );

        // SYM bit 8, length 9, Motorola: the low bit lands on the high bit of byte 2.
        // `/f:0` is an unset scale and decodes as the raw value.
        let scaled = SymParser::parse(
            r#"
{SENDRECEIVE}
[Values]
ID=1A1h
Len=8
Var=CurrentLV unsigned 8,9 -m /u:A /o:-255
Var=ModeOfOperation unsigned 16,8 /f:0
"#,
        )
        .unwrap();
        let values = scaled.decode_message(0x1A1, &[0, 0, 0x80, 0]);
        assert_eq!(decoded(&values, "CurrentLV").physical_value, -254.0);
        let mode = scaled.decode_message(0x1A1, &[0, 0, 1, 0]);
        assert_eq!(decoded(&mode, "ModeOfOperation").physical_value, 1.0);
    }

    #[test]
    fn applies_factor_offset_and_raw_enum_together() {
        let sym = r#"
{ENUMS}
Enum=lvCurrentReadingFault(1023="LV_CURRENT_READING_FAULT")
Enum=lvPowerReadingFault(4095="LV_POWER_READING_FAULT")
{SIGNALS}
Sig=temp_Cabin_VCU unsigned 10 /u:C /f:0.1 /o:-40
Sig=curr_LVB_PSC unsigned 10 /u:A /o:-200 /e:lvCurrentReadingFault
Sig=pwr_LVB_PSC unsigned 12 /u:W /f:2 /o:-2960 /e:lvPowerReadingFault
Sig=dev_TorqReq_DCU unsigned 12 -m /f:0.5 /o:-1000
{SENDRECEIVE}
[VCU_Cmd3]
ID=135h
Len=8
Sig=temp_Cabin_VCU 16
[PSC_Status6]
ID=109h
Len=8
Sig=curr_LVB_PSC 0
Sig=pwr_LVB_PSC 10
[DCU_DevA10]
ID=6F4h
Len=8
Sig=dev_TorqReq_DCU 16
"#;

        let db = SymParser::parse(sym).unwrap();

        // raw 400 * 0.1 + (-40) = 0 C. Intel bits 16..25.
        let cabin = db.decode_message(0x135, &[0, 0, 0x90, 0x01, 0, 0, 0, 0]);
        let temp = decoded(&cabin, "temp_Cabin_VCU");
        assert!((temp.physical_value - 0.0).abs() < 1e-9);
        assert_eq!(temp.unit, "C");

        let zero = db.decode_message(0x109, &[0, 0, 0, 0, 0, 0, 0, 0]);
        assert!((decoded(&zero, "curr_LVB_PSC").physical_value - -200.0).abs() < 1e-9);
        assert!(decoded(&zero, "curr_LVB_PSC").value_name.is_none());

        // Sentinel 1023 is named from the raw value. Physical is still raw + offset.
        let fault = db.decode_message(0x109, &[0xFF, 0x03, 0, 0, 0, 0, 0, 0]);
        let current = decoded(&fault, "curr_LVB_PSC");
        assert_eq!(current.raw_value, 1023);
        assert_eq!(
            current.value_name.as_deref(),
            Some("LV_CURRENT_READING_FAULT")
        );
        assert!((current.physical_value - 823.0).abs() < 1e-9);

        // 12 bits at start 10, raw 4095. Enum stays on the raw code.
        let power = db.decode_message(0x109, &[0, 0xFC, 0x3F, 0, 0, 0, 0, 0]);
        let watts = decoded(&power, "pwr_LVB_PSC");
        assert_eq!(watts.raw_value, 4095);
        assert_eq!(watts.value_name.as_deref(), Some("LV_POWER_READING_FAULT"));
        assert!((watts.physical_value - 5230.0).abs() < 1e-9);

        // `-m` is on the template, not the assignment. SYM bit 16 becomes DBC bit 23.
        let torque = db.get_message(0x6F4).unwrap();
        let torq = torque
            .signals
            .iter()
            .find(|s| s.name == "dev_TorqReq_DCU")
            .unwrap();
        assert_eq!(torq.byte_order, ByteOrder::BigEndian);
        assert_eq!(torq.start_bit, 23);
        assert!((torq.factor - 0.5).abs() < 1e-12);
        assert!((torq.offset - -1000.0).abs() < 1e-12);
        // raw 2000 * 0.5 + (-1000) = 0
        let torq_msg = db.decode_message(0x6F4, &[0, 0, 0x7D, 0, 0, 0, 0, 0]);
        assert!((decoded(&torq_msg, "dev_TorqReq_DCU").physical_value - 0.0).abs() < 1e-9);
    }

    #[test]
    fn decodes_only_the_matching_multiplex_page() {
        let sym = r#"
{SIGNALS}
Sig=status_BlLogLvd_PSC unsigned 1
Sig=status_BlLogSLvd_PSC unsigned 1
Sig=status_BlLogAppFlags_PSC unsigned 32
{SENDRECEIVE}
[PSC_BLLog]
ID=75Fh
Len=8
Mux=ResetStatusRegister 0,24 0
Sig=status_BlLogLvd_PSC 33
[PSC_BLLog]
Len=8
Mux=StickyResetStatusRegister 0,24 010000h
Sig=status_BlLogSLvd_PSC 33
[PSC_BLLog]
Len=8
Mux=Flags 0,24 020000h
Sig=status_BlLogAppFlags_PSC 32
[Next]
ID=100h
Len=1
Var=plain unsigned 0,8
"#;

        let db = SymParser::parse(sym).unwrap();
        let msg = db.get_message(0x75F).unwrap();
        assert_eq!(msg.signals.len(), 4);
        assert!(msg.signals.iter().any(|s| s.is_multiplexer));
        assert!(db
            .get_message(0x100)
            .unwrap()
            .signals
            .iter()
            .any(|s| s.name == "plain"));

        let reset = db.decode_message(0x75F, &[0, 0, 0, 0, 0x02, 0, 0, 0]);
        assert_eq!(
            decoded(&reset, "PSC_BLLog MUX").value_name.as_deref(),
            Some("ResetStatusRegister")
        );
        assert_eq!(decoded(&reset, "status_BlLogLvd_PSC").physical_value, 1.0);
        assert!(reset.iter().all(|s| s.name != "status_BlLogSLvd_PSC"));
        assert!(reset.iter().all(|s| s.name != "status_BlLogAppFlags_PSC"));

        // 010000h is little-endian bytes 00 00 01.
        let sticky = db.decode_message(0x75F, &[0x00, 0x00, 0x01, 0, 0x02, 0, 0, 0]);
        assert_eq!(decoded(&sticky, "PSC_BLLog MUX").raw_value, 0x010000);
        assert_eq!(
            decoded(&sticky, "PSC_BLLog MUX").value_name.as_deref(),
            Some("StickyResetStatusRegister")
        );
        assert_eq!(decoded(&sticky, "status_BlLogSLvd_PSC").physical_value, 1.0);
        assert!(sticky.iter().all(|s| s.name != "status_BlLogLvd_PSC"));
    }

    #[test]
    fn parses_vehicle_can_symbol_file_when_present() {
        let path = std::path::Path::new(
            "/Users/zachrobertson/Working/LightshipVehicleControls/PCAN/L1_Vehicle-CAN_Beta2.sym",
        );
        if !path.exists() {
            return;
        }
        let db = SymParser::parse_file(path).unwrap();

        assert_eq!(
            db.value_tables["statePowerSystemManagement"]
                .values
                .get(&32)
                .map(String::as_str),
            Some("DRIVE_CONTACTOR_CONTROL_ENABLE")
        );
        assert_eq!(
            db.value_tables["protoSystemStatusErrorCode"]
                .values
                .get(&4)
                .map(String::as_str),
            Some("SystemErrorStatusCodeDoorLockNotRespondingToCommand")
        );

        let cabin = db
            .get_message(0x135)
            .unwrap()
            .signals
            .iter()
            .find(|s| s.name == "temp_Cabin_VCU")
            .unwrap();
        assert!((cabin.factor - 0.1).abs() < 1e-12);
        assert!((cabin.offset - -40.0).abs() < 1e-12);

        let status6 = db.get_message(0x109).unwrap();
        let current = status6
            .signals
            .iter()
            .find(|s| s.name == "curr_LVB_PSC")
            .unwrap();
        assert!((current.offset - -200.0).abs() < 1e-12);
        assert_eq!(
            current.value_table.as_deref(),
            Some("lvCurrentReadingFault")
        );
        let power = status6
            .signals
            .iter()
            .find(|s| s.name == "pwr_LVB_PSC")
            .unwrap();
        assert!((power.factor - 2.0).abs() < 1e-12);
        assert!((power.offset - -2960.0).abs() < 1e-12);

        let accel = db
            .get_message(0x6FE)
            .unwrap()
            .signals
            .iter()
            .find(|s| s.name == "dev_AccelX_DCU")
            .unwrap();
        assert!((accel.offset - -32.0).abs() < 1e-12);
        let accel_msg = db.decode_message(0x6FE, &[0x00, 0x20, 0, 0, 0, 0, 0, 0]);
        let g = decoded(&accel_msg, "dev_AccelX_DCU").physical_value;
        assert!((g - (8192.0 * accel.factor - 32.0)).abs() < 1e-6);

        // `/min:0 /max:1` is a placeholder and must not clamp the decoded value.
        let hella = db.decode_message(0x6EE, &[0x80, 0x84, 0x1E, 0, 0, 0, 0, 0]);
        let amps = decoded(&hella, "dev_HellaLvCurrentRaw_PSC").physical_value;
        assert!((amps - 0.0).abs() < 1e-6);

        let log = db.get_message(0x75F).unwrap();
        assert!(log.signals.iter().any(|s| s.name == "status_BlLogLvd_PSC"));
        assert!(log.signals.iter().any(|s| s.name == "status_BlLogSLvd_PSC"));
        assert!(log
            .signals
            .iter()
            .any(|s| s.name == "status_BlLogAppFlags_PSC"));
        let sticky = db.decode_message(0x75F, &[0x00, 0x00, 0x01, 0, 0, 0, 0, 0]);
        assert_eq!(
            decoded(&sticky, "PSC_BLLog MUX").value_name.as_deref(),
            Some("StickyResetStatusRegister")
        );
        assert!(sticky.iter().all(|s| s.name != "status_BlLogLvd_PSC"));
        assert!(sticky.iter().any(|s| s.name == "status_BlLogSLvd_PSC"));

        let torque = db
            .get_message(0x6F4)
            .unwrap()
            .signals
            .iter()
            .find(|s| s.name == "dev_TorqReq_DCU")
            .unwrap();
        assert_eq!(torque.byte_order, ByteOrder::BigEndian);
        assert_eq!(torque.start_bit, 23);
        assert!((torque.factor - 0.5).abs() < 1e-12);
        assert!((torque.offset - -1000.0).abs() < 1e-12);
    }
}
