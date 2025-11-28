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
    pub fn decode_signal(&self, message_id: u32, signal_name: &str, data: &[u8]) -> Option<DecodedSignal> {
        let message = self.get_message(message_id)?;
        let signal = message.signals.iter().find(|s| s.name == signal_name)?;

        // Extract raw value based on signal definition
        let raw_value = signal.extract_raw_value(data)?;

        // Apply scaling
        let physical_value = (raw_value as f64) * signal.factor + signal.offset;

        // Check value table
        let value_name = if let Some(ref vt_name) = signal.value_table {
            self.value_tables.get(vt_name)
                .and_then(|vt| vt.values.get(&raw_value))
                .cloned()
        } else {
            None
        };

        Some(DecodedSignal {
            name: signal.name.clone(),
            raw_value,
            physical_value,
            unit: signal.unit.clone(),
            value_name,
        })
    }

    /// Decode all signals in a message
    pub fn decode_message(&self, message_id: u32, data: &[u8]) -> Vec<DecodedSignal> {
        if let Some(message) = self.get_message(message_id) {
            message.signals
                .iter()
                .filter_map(|signal| {
                    let raw_value = signal.extract_raw_value(data)?;
                    let physical_value = (raw_value as f64) * signal.factor + signal.offset;
                    let value_name = signal.value_table.as_ref()
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
                })
                .collect()
        } else {
            vec![]
        }
    }
}

impl Signal {
    /// Extract raw integer value from CAN data
    fn extract_raw_value(&self, data: &[u8]) -> Option<i64> {
        if data.len() < 8 {
            return None;
        }

        let start_byte = (self.start_bit / 8) as usize;
        let start_bit_in_byte = (self.start_bit % 8) as u8;

        match self.value_type {
            ValueType::Unsigned => {
                self.extract_unsigned(data, start_byte, start_bit_in_byte)
            }
            ValueType::Signed => {
                self.extract_signed(data, start_byte, start_bit_in_byte)
            }
            ValueType::Float => {
                if self.length == 32 {
                    self.extract_float(data, start_byte)
                } else {
                    None
                }
            }
            ValueType::Double => {
                if self.length == 64 {
                    self.extract_double(data, start_byte)
                } else {
                    None
                }
            }
        }
    }

    fn extract_unsigned(&self, data: &[u8], start_byte: usize, start_bit: u8) -> Option<i64> {
        let mut value: u64 = 0;
        let mut bits_remaining = self.length;
        let mut current_byte = start_byte;
        let mut current_bit = start_bit;

        for _ in 0..self.length {
            if current_byte >= data.len() {
                return None;
            }

            let bit_value = ((data[current_byte] >> current_bit) & 1) as u64;
            value |= bit_value << (self.length - bits_remaining);

            bits_remaining -= 1;
            current_bit += 1;
            if current_bit >= 8 {
                current_bit = 0;
                current_byte += 1;
            }
        }

        Some(value as i64)
    }

    fn extract_signed(&self, data: &[u8], start_byte: usize, start_bit: u8) -> Option<i64> {
        let unsigned = self.extract_unsigned(data, start_byte, start_bit)?;
        
        // Sign extension
        let sign_bit = 1 << (self.length - 1);
        if (unsigned as u64) & sign_bit != 0 {
            let mask = (1u64 << self.length) - 1;
            Some((unsigned as u64 | !mask) as i64)
        } else {
            Some(unsigned)
        }
    }

    fn extract_float(&self, data: &[u8], start_byte: usize) -> Option<i64> {
        if start_byte + 4 > data.len() {
            return None;
        }

        let bytes = &data[start_byte..start_byte + 4];
        let bits = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        let float_val = f32::from_bits(bits);
        Some(float_val as i64) // Return as integer representation
    }

    fn extract_double(&self, data: &[u8], start_byte: usize) -> Option<i64> {
        if start_byte + 8 > data.len() {
            return None;
        }

        let bytes = &data[start_byte..start_byte + 8];
        let bits = u64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
        ]);
        let double_val = f64::from_bits(bits);
        Some(double_val as i64) // Return as integer representation
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

