use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// DBC database containing all parsed information
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DbcDatabase {
    pub version: Option<String>,
    pub messages: HashMap<u32, Message>,
    pub nodes: Vec<String>,
    pub value_tables: HashMap<String, ValueTable>,
}

/// CAN message definition from DBC
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: u32,
    pub name: String,
    pub dlc: u8,
    pub sender: Option<String>,
    pub signals: Vec<Signal>,
    pub comment: Option<String>,
}

/// Signal definition within a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    pub name: String,
    pub start_bit: u8,
    pub length: u8,
    pub byte_order: ByteOrder,
    pub value_type: ValueType,
    pub factor: f64,
    pub offset: f64,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub unit: String,
    pub receivers: Vec<String>,
    pub comment: Option<String>,
    pub value_table: Option<String>, // Reference to value table name
    /// Selects which multiplexed signals are present. Always decoded.
    #[serde(default)]
    pub is_multiplexer: bool,
    /// Decoded only when the message multiplexor equals this raw value.
    #[serde(default)]
    pub multiplex: Option<u64>,
}

/// Byte order (endianness)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ByteOrder {
    LittleEndian,
    BigEndian,
}

/// Signal value type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ValueType {
    Unsigned,
    Signed,
    Float,
    Double,
}

/// Value table for enumerated values
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValueTable {
    pub name: String,
    pub values: HashMap<i64, String>,
}

impl DbcDatabase {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get a message by ID
    pub fn get_message(&self, id: u32) -> Option<&Message> {
        self.messages.get(&id)
    }

    /// Decode a signal from raw CAN data
    pub fn decode_signal(
        &self,
        message_id: u32,
        signal_name: &str,
        data: &[u8],
    ) -> Option<DecodedSignal> {
        let message = self.get_message(message_id)?;
        let signal = message.signals.iter().find(|s| s.name == signal_name)?;
        self.decode_one(signal, data)
    }

    /// Decode all signals in a message
    pub fn decode_message(&self, message_id: u32, data: &[u8]) -> Vec<DecodedSignal> {
        let Some(message) = self.get_message(message_id) else {
            return vec![];
        };
        let mux_value = message
            .signals
            .iter()
            .find(|signal| signal.is_multiplexer)
            .and_then(|signal| match signal.extract_value(data)? {
                SignalValue::Integer(value) if value >= 0 => Some(value as u64),
                _ => None,
            });
        message
            .signals
            .iter()
            .filter(|signal| match signal.multiplex {
                Some(expected) => mux_value == Some(expected),
                None => true,
            })
            .filter_map(|signal| self.decode_one(signal, data))
            .collect()
    }

    fn decode_one(&self, signal: &Signal, data: &[u8]) -> Option<DecodedSignal> {
        let (raw_value, physical_value) = match signal.extract_value(data)? {
            SignalValue::Integer(i) => (i, i as f64 * signal.factor + signal.offset),
            SignalValue::Float(f) => (f.round() as i64, f * signal.factor + signal.offset),
        };

        let value_name = signal
            .value_table
            .as_ref()
            .and_then(|vt_name| self.value_tables.get(vt_name))
            .and_then(|vt| vt.values.get(&raw_value))
            .cloned();

        Some(DecodedSignal {
            name: signal.name.clone(),
            raw_value,
            physical_value,
            unit: signal.unit.clone(),
            value_name,
        })
    }

    /// Encode physical signal values into a message payload.
    ///
    /// Starts from `base` bytes when given (preserving signals that aren't in
    /// `values`), otherwise from zeroed bytes of the message's DLC.
    pub fn encode_signals(
        &self,
        message_id: u32,
        values: &HashMap<String, f64>,
        base: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, String> {
        let message = self
            .get_message(message_id)
            .ok_or_else(|| format!("Unknown message id 0x{:X}", message_id))?;

        let mut data = base.unwrap_or_default();
        data.resize(message.dlc as usize, 0);

        for (name, value) in values {
            let signal = message
                .signals
                .iter()
                .find(|s| &s.name == name)
                .ok_or_else(|| format!("Unknown signal '{}' in message {}", name, message.name))?;
            signal.pack(&mut data, *value)?;
        }
        Ok(data)
    }
}

/// A raw signal value before factor/offset scaling.
enum SignalValue {
    Integer(i64),
    Float(f64),
}

/// Absolute bit positions of a signal ordered MSB-first, honoring byte order.
/// Bit position numbering: bit b lives in byte `b / 8` at in-byte bit `b % 8`
/// (LSB-first within a byte), matching the DBC/SYM convention.
///
/// This walk is shared by decode and encode so the two can never diverge.
fn bit_positions_msb_first(start_bit: u8, length: u8, byte_order: ByteOrder) -> Vec<u16> {
    let mut positions = Vec::with_capacity(length as usize);
    match byte_order {
        ByteOrder::LittleEndian => {
            // Intel: start_bit is the LSB; MSB is start_bit + length - 1
            let start = start_bit as u16;
            for i in (0..length as u16).rev() {
                positions.push(start + i);
            }
        }
        ByteOrder::BigEndian => {
            // Motorola: start_bit is the MSB; walk descends within a byte,
            // then jumps to the MSB-side of the next byte (the sawtooth).
            let mut pos = start_bit as u16;
            for _ in 0..length {
                positions.push(pos);
                pos = if pos % 8 == 0 { pos + 15 } else { pos - 1 };
            }
        }
    }
    positions
}

fn get_bit(data: &[u8], pos: u16) -> Option<u64> {
    let byte = (pos / 8) as usize;
    if byte >= data.len() {
        return None;
    }
    Some(((data[byte] >> (pos % 8)) & 1) as u64)
}

fn set_bit(data: &mut [u8], pos: u16, bit: u64) -> Result<(), String> {
    let byte = (pos / 8) as usize;
    if byte >= data.len() {
        return Err(format!("Signal bit {} outside message payload", pos));
    }
    let mask = 1u8 << (pos % 8);
    if bit != 0 {
        data[byte] |= mask;
    } else {
        data[byte] &= !mask;
    }
    Ok(())
}

impl Signal {
    /// Extract the raw signal value from CAN data. Returns None when the
    /// signal is not fully contained in the payload (e.g. short DLC).
    fn extract_value(&self, data: &[u8]) -> Option<SignalValue> {
        if self.length == 0 || self.length > 64 {
            return None;
        }
        let mut raw: u64 = 0;
        for pos in bit_positions_msb_first(self.start_bit, self.length, self.byte_order) {
            raw = (raw << 1) | get_bit(data, pos)?;
        }

        match self.value_type {
            ValueType::Unsigned => Some(SignalValue::Integer(raw as i64)),
            ValueType::Signed => {
                // Sign extension
                let sign_bit = 1u64 << (self.length - 1);
                let value = if raw & sign_bit != 0 {
                    let mask = if self.length == 64 {
                        u64::MAX
                    } else {
                        (1u64 << self.length) - 1
                    };
                    (raw | !mask) as i64
                } else {
                    raw as i64
                };
                Some(SignalValue::Integer(value))
            }
            ValueType::Float => {
                if self.length != 32 {
                    return None;
                }
                Some(SignalValue::Float(f32::from_bits(raw as u32) as f64))
            }
            ValueType::Double => {
                if self.length != 64 {
                    return None;
                }
                Some(SignalValue::Float(f64::from_bits(raw)))
            }
        }
    }

    /// Pack a physical value into the payload, clamping to the signal's
    /// min/max (when meaningful) and its bit width.
    pub fn pack(&self, data: &mut [u8], physical: f64) -> Result<(), String> {
        if self.length == 0 || self.length > 64 {
            return Err(format!(
                "Signal '{}' has invalid length {}",
                self.name, self.length
            ));
        }
        if self.factor == 0.0 {
            return Err(format!("Signal '{}' has zero factor", self.name));
        }

        // Clamp to min/max when the range is meaningful (min < max).
        let mut phys = physical;
        if let (Some(min), Some(max)) = (self.minimum, self.maximum) {
            if min < max {
                phys = phys.clamp(min, max);
            }
        }

        let width_mask = if self.length == 64 {
            u64::MAX
        } else {
            (1u64 << self.length) - 1
        };
        let raw_scaled = (phys - self.offset) / self.factor;

        let raw: u64 = match self.value_type {
            ValueType::Unsigned => {
                let max = width_mask as f64;
                raw_scaled.round().clamp(0.0, max) as u64
            }
            ValueType::Signed => {
                let min = -(2f64.powi(self.length as i32 - 1));
                let max = 2f64.powi(self.length as i32 - 1) - 1.0;
                let v = raw_scaled.round().clamp(min, max) as i64;
                // Two's-complement truncation to the signal width
                (v as u64) & width_mask
            }
            ValueType::Float => {
                if self.length != 32 {
                    return Err(format!("Float signal '{}' must be 32 bits", self.name));
                }
                (raw_scaled as f32).to_bits() as u64
            }
            ValueType::Double => {
                if self.length != 64 {
                    return Err(format!("Double signal '{}' must be 64 bits", self.name));
                }
                raw_scaled.to_bits()
            }
        };

        let positions = bit_positions_msb_first(self.start_bit, self.length, self.byte_order);
        for (i, pos) in positions.iter().enumerate() {
            let bit = (raw >> (self.length as usize - 1 - i)) & 1;
            set_bit(data, *pos, bit)?;
        }
        Ok(())
    }
}

/// Decoded signal value
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedSignal {
    pub name: String,
    pub raw_value: i64,
    pub physical_value: f64,
    pub unit: String,
    pub value_name: Option<String>, // Enumerated value name if available
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal(
        name: &str,
        start_bit: u8,
        length: u8,
        byte_order: ByteOrder,
        value_type: ValueType,
        factor: f64,
        offset: f64,
    ) -> Signal {
        Signal {
            name: name.to_string(),
            start_bit,
            length,
            byte_order,
            value_type,
            factor,
            offset,
            minimum: None,
            maximum: None,
            unit: String::new(),
            receivers: vec![],
            comment: None,
            value_table: None,
            is_multiplexer: false,
            multiplex: None,
        }
    }

    fn db_with(signals: Vec<Signal>, dlc: u8) -> DbcDatabase {
        let mut db = DbcDatabase::new();
        db.messages.insert(
            0x100,
            Message {
                id: 0x100,
                name: "Test".to_string(),
                dlc,
                sender: None,
                signals,
                comment: None,
            },
        );
        db
    }

    #[test]
    fn intel_unsigned_known_vector() {
        // 16-bit Intel unsigned at bit 8 = bytes 1..2 little-endian
        let s = signal(
            "s",
            8,
            16,
            ByteOrder::LittleEndian,
            ValueType::Unsigned,
            1.0,
            0.0,
        );
        let db = db_with(vec![s], 8);
        let data = [0x00, 0x34, 0x12, 0, 0, 0, 0, 0];
        let decoded = db.decode_message(0x100, &data);
        assert_eq!(decoded[0].raw_value, 0x1234);
    }

    #[test]
    fn motorola_unsigned_known_vector() {
        // 16-bit Motorola with MSB at bit 7 = bytes 0..1 big-endian
        // (cross-checked against cantools: start=7, length=16, big_endian)
        let s = signal(
            "s",
            7,
            16,
            ByteOrder::BigEndian,
            ValueType::Unsigned,
            1.0,
            0.0,
        );
        let db = db_with(vec![s], 8);
        let data = [0x12, 0x34, 0, 0, 0, 0, 0, 0];
        let decoded = db.decode_message(0x100, &data);
        assert_eq!(decoded[0].raw_value, 0x1234);
    }

    #[test]
    fn short_dlc_frames_decode_contained_signals() {
        // Signal fully inside 2 bytes must decode from a DLC-2 frame
        let s = signal(
            "s",
            0,
            16,
            ByteOrder::LittleEndian,
            ValueType::Unsigned,
            1.0,
            0.0,
        );
        let db = db_with(vec![s], 2);
        let decoded = db.decode_message(0x100, &[0xCD, 0xAB]);
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].raw_value, 0xABCD);

        // A signal extending beyond the payload must be skipped, not error
        let s2 = signal(
            "s2",
            8,
            16,
            ByteOrder::LittleEndian,
            ValueType::Unsigned,
            1.0,
            0.0,
        );
        let db2 = db_with(vec![s2], 3);
        assert!(db2.decode_message(0x100, &[0xFF]).is_empty());
    }

    #[test]
    fn float_signal_keeps_fraction() {
        let s = signal(
            "f",
            0,
            32,
            ByteOrder::LittleEndian,
            ValueType::Float,
            1.0,
            0.0,
        );
        let db = db_with(vec![s], 4);
        let data = 1.5f32.to_le_bytes();
        let decoded = db.decode_message(0x100, &data);
        assert_eq!(decoded[0].physical_value, 1.5);
    }

    #[test]
    fn signed_sign_extension() {
        let s = signal(
            "s",
            0,
            12,
            ByteOrder::LittleEndian,
            ValueType::Signed,
            1.0,
            0.0,
        );
        let db = db_with(vec![s], 8);
        // 12-bit -1 = 0xFFF
        let data = [0xFF, 0x0F, 0, 0, 0, 0, 0, 0];
        let decoded = db.decode_message(0x100, &data);
        assert_eq!(decoded[0].raw_value, -1);
    }

    #[test]
    fn encode_decode_round_trip() {
        let cases = vec![
            signal(
                "a",
                0,
                8,
                ByteOrder::LittleEndian,
                ValueType::Unsigned,
                1.0,
                0.0,
            ),
            signal(
                "b",
                8,
                12,
                ByteOrder::LittleEndian,
                ValueType::Signed,
                0.5,
                -100.0,
            ),
            signal(
                "c",
                31,
                16,
                ByteOrder::BigEndian,
                ValueType::Unsigned,
                0.125,
                0.0,
            ),
            signal(
                "d",
                55,
                10,
                ByteOrder::BigEndian,
                ValueType::Signed,
                1.0,
                0.0,
            ),
        ];
        let db = db_with(cases, 8);

        let mut values = HashMap::new();
        values.insert("a".to_string(), 200.0);
        values.insert("b".to_string(), -75.5);
        values.insert("c".to_string(), 1234.125);
        values.insert("d".to_string(), -300.0);

        let data = db.encode_signals(0x100, &values, None).unwrap();
        let decoded = db.decode_message(0x100, &data);
        assert_eq!(decoded.len(), 4);
        for d in decoded {
            let expected = values[&d.name];
            assert!(
                (d.physical_value - expected).abs() < 1e-9,
                "signal {} decoded {} != {}",
                d.name,
                d.physical_value,
                expected
            );
        }
    }

    /// Golden vector cross-checked against python-cantools 42.0.3:
    /// encoding {a: 200, b: -75.5, c: 1234.125, d: -300} with these exact
    /// signal definitions produces C8 31 00 26 91 00 B5 00.
    #[test]
    fn encode_matches_cantools_golden() {
        let cases = vec![
            signal(
                "a",
                0,
                8,
                ByteOrder::LittleEndian,
                ValueType::Unsigned,
                1.0,
                0.0,
            ),
            signal(
                "b",
                8,
                12,
                ByteOrder::LittleEndian,
                ValueType::Signed,
                0.5,
                -100.0,
            ),
            signal(
                "c",
                31,
                16,
                ByteOrder::BigEndian,
                ValueType::Unsigned,
                0.125,
                0.0,
            ),
            signal(
                "d",
                55,
                10,
                ByteOrder::BigEndian,
                ValueType::Signed,
                1.0,
                0.0,
            ),
        ];
        let db = db_with(cases, 8);
        let mut values = HashMap::new();
        values.insert("a".to_string(), 200.0);
        values.insert("b".to_string(), -75.5);
        values.insert("c".to_string(), 1234.125);
        values.insert("d".to_string(), -300.0);
        let data = db.encode_signals(0x100, &values, None).unwrap();
        assert_eq!(data, vec![0xC8, 0x31, 0x00, 0x26, 0x91, 0x00, 0xB5, 0x00]);
    }

    #[test]
    fn encode_preserves_base_bytes() {
        let s = signal(
            "a",
            8,
            8,
            ByteOrder::LittleEndian,
            ValueType::Unsigned,
            1.0,
            0.0,
        );
        let db = db_with(vec![s], 4);
        let base = vec![0xDE, 0x00, 0xBE, 0xEF];
        let mut values = HashMap::new();
        values.insert("a".to_string(), 0xAD as f64);
        let data = db.encode_signals(0x100, &values, Some(base)).unwrap();
        assert_eq!(data, vec![0xDE, 0xAD, 0xBE, 0xEF]);
    }

    #[test]
    fn encode_clamps_to_range_and_width() {
        let mut s = signal(
            "a",
            0,
            8,
            ByteOrder::LittleEndian,
            ValueType::Unsigned,
            1.0,
            0.0,
        );
        s.minimum = Some(0.0);
        s.maximum = Some(100.0);
        let db = db_with(vec![s], 1);
        let mut values = HashMap::new();
        values.insert("a".to_string(), 5000.0);
        let data = db.encode_signals(0x100, &values, None).unwrap();
        assert_eq!(data[0], 100);
    }

    #[test]
    fn round_trip_float_signal() {
        let s = signal("f", 7, 32, ByteOrder::BigEndian, ValueType::Float, 1.0, 0.0);
        let db = db_with(vec![s], 4);
        let mut values = HashMap::new();
        values.insert("f".to_string(), 3.25);
        let data = db.encode_signals(0x100, &values, None).unwrap();
        let decoded = db.decode_message(0x100, &data);
        assert_eq!(decoded[0].physical_value, 3.25);
    }
}
