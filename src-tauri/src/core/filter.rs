use crate::core::message::CanFrame;
use serde::{Deserialize, Serialize};

/// Filter rule for CAN messages
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FilterRule {
    /// Filter by ID range (inclusive)
    IdRange { min: u32, max: u32 },
    /// Filter by exact ID
    IdExact(u32),
    /// Filter by data pattern (byte positions and values)
    DataPattern { pattern: Vec<DataByteMatch> },
    /// Filter by DLC
    DlcRange { min: u8, max: u8 },
    /// Filter by direction
    Direction { rx: bool, tx: bool },
    /// Filter by extended ID flag
    ExtendedId(bool),
    /// Filter by remote frame flag
    RemoteFrame(bool),
}

/// Data byte match specification
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataByteMatch {
    pub position: u8,
    pub value: u8,
    pub mask: u8, // Bit mask (0xFF = exact match, 0x00 = don't care)
}

/// Filter set with logical operators
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterSet {
    pub rules: Vec<FilterRule>,
    pub logic: FilterLogic,
}

/// Logical operator for combining filter rules
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FilterLogic {
    And, // All rules must match
    Or,  // Any rule must match
}

impl FilterRule {
    /// Check if a frame matches this filter rule
    pub fn matches(&self, frame: &CanFrame) -> bool {
        match self {
            FilterRule::IdRange { min, max } => {
                frame.id >= *min && frame.id <= *max
            }
            FilterRule::IdExact(id) => {
                frame.id == *id
            }
            FilterRule::DataPattern { pattern } => {
                pattern.iter().all(|match_spec| {
                    if (match_spec.position as usize) < frame.data.len() {
                        let byte = frame.data[match_spec.position as usize];
                        (byte & match_spec.mask) == (match_spec.value & match_spec.mask)
                    } else {
                        false
                    }
                })
            }
            FilterRule::DlcRange { min, max } => {
                frame.dlc >= *min && frame.dlc <= *max
            }
            FilterRule::Direction { rx, tx } => {
                (frame.direction == "rx" && *rx) || (frame.direction == "tx" && *tx)
            }
            FilterRule::ExtendedId(extended) => {
                frame.is_extended == *extended
            }
            FilterRule::RemoteFrame(remote) => {
                frame.is_remote == *remote
            }
        }
    }
}

impl FilterSet {
    /// Create a new filter set
    pub fn new(rules: Vec<FilterRule>, logic: FilterLogic) -> Self {
        Self { rules, logic }
    }

    /// Check if a frame matches the filter set
    pub fn matches(&self, frame: &CanFrame) -> bool {
        if self.rules.is_empty() {
            return true; // No filters = match all
        }

        match self.logic {
            FilterLogic::And => {
                self.rules.iter().all(|rule| rule.matches(frame))
            }
            FilterLogic::Or => {
                self.rules.iter().any(|rule| rule.matches(frame))
            }
        }
    }

    /// Check if filter set is empty (no filtering)
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }
}

impl Default for FilterSet {
    fn default() -> Self {
        Self {
            rules: vec![],
            logic: FilterLogic::And,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_id_range_filter() {
        let filter = FilterRule::IdRange { min: 0x100, max: 0x200 };
        let frame1 = CanFrame {
            id: 0x150,
            ..Default::default()
        };
        let frame2 = CanFrame {
            id: 0x300,
            ..Default::default()
        };

        assert!(filter.matches(&frame1));
        assert!(!filter.matches(&frame2));
    }

    #[test]
    fn test_data_pattern_filter() {
        let filter = FilterRule::DataPattern {
            pattern: vec![
                DataByteMatch {
                    position: 0,
                    value: 0x01,
                    mask: 0xFF,
                },
            ],
        };
        let mut frame1 = CanFrame::default();
        frame1.data = vec![0x01, 0x02, 0x03];
        let mut frame2 = CanFrame::default();
        frame2.data = vec![0x02, 0x02, 0x03];

        assert!(filter.matches(&frame1));
        assert!(!filter.matches(&frame2));
    }

    #[test]
    fn test_filter_set_and() {
        let filter_set = FilterSet::new(
            vec![
                FilterRule::IdRange { min: 0x100, max: 0x200 },
                FilterRule::Direction { rx: true, tx: false },
            ],
            FilterLogic::And,
        );

        let mut frame1 = CanFrame::default();
        frame1.id = 0x150;
        frame1.direction = "rx".to_string();

        let mut frame2 = CanFrame::default();
        frame2.id = 0x150;
        frame2.direction = "tx".to_string();

        assert!(filter_set.matches(&frame1));
        assert!(!filter_set.matches(&frame2));
    }
}

