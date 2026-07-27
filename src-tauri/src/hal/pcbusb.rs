//! Runtime bindings to the PCAN-Basic compatible library.
//!
//! On macOS this is the MacCAN PCBUSB library (libPCBUSB.dylib, see
//! https://mac-can.github.io); on Windows it is PEAK's PCANBasic.dll.
//! The library is loaded with dlopen at runtime so the app builds and runs
//! on machines without the driver installed.
//!
//! All constants and struct layouts below were verified against PCBUSB.h
//! v0.13 (mac-can/PCBUSB-Library, Binaries/Universal_64) which matches the
//! official PCANBasic.h values.

use libloading::Library;
use std::ffi::c_void;
use std::os::raw::c_char;
use std::sync::OnceLock;

// --- PCAN channel handles -------------------------------------------------

pub const PCAN_USBBUS1: u16 = 0x51;
pub const PCAN_USBBUS8: u16 = 0x58;

// --- Error / status codes (bit flags) -------------------------------------

pub const PCAN_ERROR_OK: u32 = 0x00000;
pub const PCAN_ERROR_XMTFULL: u32 = 0x00001;
pub const PCAN_ERROR_OVERRUN: u32 = 0x00002;
pub const PCAN_ERROR_BUSLIGHT: u32 = 0x00004;
pub const PCAN_ERROR_BUSHEAVY: u32 = 0x00008;
pub const PCAN_ERROR_BUSPASSIVE: u32 = 0x40000;
pub const PCAN_ERROR_BUSOFF: u32 = 0x00010;
pub const PCAN_ERROR_ANYBUSERR: u32 = PCAN_ERROR_BUSLIGHT
    | PCAN_ERROR_BUSHEAVY
    | PCAN_ERROR_BUSOFF
    | PCAN_ERROR_BUSPASSIVE;
pub const PCAN_ERROR_QRCVEMPTY: u32 = 0x00020;
pub const PCAN_ERROR_QOVERRUN: u32 = 0x00040;
pub const PCAN_ERROR_QXMTFULL: u32 = 0x00080;
pub const PCAN_ERROR_NODRIVER: u32 = 0x00200;
pub const PCAN_ERROR_HWINUSE: u32 = 0x00400;
pub const PCAN_ERROR_NETINUSE: u32 = 0x00800;
pub const PCAN_ERROR_ILLHW: u32 = 0x01400;
pub const PCAN_ERROR_INITIALIZE: u32 = 0x4000000;

// --- Parameters for CAN_GetValue / CAN_SetValue ---------------------------

pub const PCAN_DEVICE_ID: u8 = 0x01;
pub const PCAN_RECEIVE_EVENT: u8 = 0x03;
pub const PCAN_API_VERSION: u8 = 0x05;
pub const PCAN_CHANNEL_CONDITION: u8 = 0x0D;
pub const PCAN_HARDWARE_NAME: u8 = 0x0E;
pub const PCAN_FIRMWARE_VERSION: u8 = 0x29;

// --- Channel condition values ---------------------------------------------

pub const PCAN_CHANNEL_AVAILABLE: u32 = 0x01;
pub const PCAN_CHANNEL_OCCUPIED: u32 = 0x02;

// --- Message type flags ----------------------------------------------------

pub const PCAN_MESSAGE_RTR: u8 = 0x01;
pub const PCAN_MESSAGE_EXTENDED: u8 = 0x02;
pub const PCAN_MESSAGE_ERRFRAME: u8 = 0x40;
pub const PCAN_MESSAGE_STATUS: u8 = 0x80;

pub const MAX_LENGTH_HARDWARE_NAME: usize = 33;
pub const MAX_LENGTH_VERSION_STRING: usize = 256;

// --- FFI structs -----------------------------------------------------------

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct TPCANMsg {
    pub id: u32,
    pub msgtype: u8,
    pub len: u8,
    pub data: [u8; 8],
}

impl Default for TPCANMsg {
    fn default() -> Self {
        Self {
            id: 0,
            msgtype: 0,
            len: 0,
            data: [0; 8],
        }
    }
}

/// Total microseconds = micros + 1000 * millis + 0x1_0000_0000 * 1000 * millis_overflow
#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct TPCANTimestamp {
    pub millis: u32,
    pub millis_overflow: u16,
    pub micros: u16,
}

impl TPCANTimestamp {
    pub fn total_micros(&self) -> u64 {
        self.micros as u64
            + 1_000 * self.millis as u64
            + 0x1_0000_0000u64 * 1_000 * self.millis_overflow as u64
    }
}

// --- Function types ---------------------------------------------------------

type CanInitializeFn = unsafe extern "C" fn(u16, u16, u8, u32, u16) -> u32;
type CanUninitializeFn = unsafe extern "C" fn(u16) -> u32;
type CanResetFn = unsafe extern "C" fn(u16) -> u32;
type CanGetStatusFn = unsafe extern "C" fn(u16) -> u32;
type CanReadFn = unsafe extern "C" fn(u16, *mut TPCANMsg, *mut TPCANTimestamp) -> u32;
type CanWriteFn = unsafe extern "C" fn(u16, *mut TPCANMsg) -> u32;
type CanFilterMessagesFn = unsafe extern "C" fn(u16, u32, u32, u8) -> u32;
type CanGetValueFn = unsafe extern "C" fn(u16, u8, *mut c_void, u32) -> u32;
type CanSetValueFn = unsafe extern "C" fn(u16, u8, *mut c_void, u32) -> u32;
type CanGetErrorTextFn = unsafe extern "C" fn(u32, u16, *mut c_char) -> u32;
// CAN FD entry points (present in PCBUSB >= 0.10); resolved but unused until
// FD support lands.
type CanInitializeFdFn = unsafe extern "C" fn(u16, *const c_char) -> u32;

/// Resolved PCAN-Basic API symbols. Obtained once via [`PcbusbApi::get`].
pub struct PcbusbApi {
    _lib: Library,
    pub can_initialize: CanInitializeFn,
    pub can_uninitialize: CanUninitializeFn,
    #[allow(dead_code)]
    pub can_reset: CanResetFn,
    pub can_get_status: CanGetStatusFn,
    pub can_read: CanReadFn,
    pub can_write: CanWriteFn,
    pub can_filter_messages: CanFilterMessagesFn,
    pub can_get_value: CanGetValueFn,
    #[allow(dead_code)]
    pub can_set_value: CanSetValueFn,
    pub can_get_error_text: CanGetErrorTextFn,
    /// Present on FD-capable library versions; kept for future CAN FD support.
    #[allow(dead_code)]
    pub can_initialize_fd: Option<CanInitializeFdFn>,
}

static API: OnceLock<Result<PcbusbApi, String>> = OnceLock::new();

fn library_candidates() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        vec![
            "/usr/local/lib/libPCBUSB.dylib".into(),
            "/opt/homebrew/lib/libPCBUSB.dylib".into(),
            "libPCBUSB.dylib".into(),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        vec!["PCANBasic.dll".into()]
    }
}

fn load_api() -> Result<PcbusbApi, String> {
    let mut last_err = String::new();
    for path in library_candidates() {
        // SAFETY: loading a well-known vendor library; symbols are resolved
        // and type-checked individually below.
        match unsafe { Library::new(&path) } {
            Ok(lib) => {
                log::info!("Loaded PCAN library from {}", path);
                return build_api(lib);
            }
            Err(e) => last_err = format!("{}: {}", path, e),
        }
    }
    Err(format!(
        "PCAN driver library not found ({}). Install the PCBUSB library from \
         https://mac-can.github.io/drivers/libPCBUSB/ to use PCAN-USB hardware.",
        last_err
    ))
}

fn build_api(lib: Library) -> Result<PcbusbApi, String> {
    macro_rules! sym {
        ($name:literal, $ty:ty) => {
            unsafe {
                *lib.get::<$ty>($name.as_bytes())
                    .map_err(|e| format!("PCAN library is missing symbol {}: {}", $name, e))?
            }
        };
    }
    let api = PcbusbApi {
        can_initialize: sym!("CAN_Initialize", CanInitializeFn),
        can_uninitialize: sym!("CAN_Uninitialize", CanUninitializeFn),
        can_reset: sym!("CAN_Reset", CanResetFn),
        can_get_status: sym!("CAN_GetStatus", CanGetStatusFn),
        can_read: sym!("CAN_Read", CanReadFn),
        can_write: sym!("CAN_Write", CanWriteFn),
        can_filter_messages: sym!("CAN_FilterMessages", CanFilterMessagesFn),
        can_get_value: sym!("CAN_GetValue", CanGetValueFn),
        can_set_value: sym!("CAN_SetValue", CanSetValueFn),
        can_get_error_text: sym!("CAN_GetErrorText", CanGetErrorTextFn),
        can_initialize_fd: unsafe {
            lib.get::<CanInitializeFdFn>(b"CAN_InitializeFD").ok().map(|s| *s)
        },
        _lib: lib,
    };
    Ok(api)
}

impl PcbusbApi {
    /// Get the process-wide API instance, loading the library on first call.
    pub fn get() -> Result<&'static PcbusbApi, String> {
        match API.get_or_init(load_api) {
            Ok(api) => Ok(api),
            Err(e) => Err(e.clone()),
        }
    }

    /// Whether the PCAN library is installed and loadable.
    pub fn is_available() -> bool {
        Self::get().is_ok()
    }

    /// Human-readable text for a PCAN status code.
    pub fn error_text(&self, status: u32) -> String {
        let mut buf = [0 as c_char; MAX_LENGTH_VERSION_STRING];
        // SAFETY: buffer is MAX_LENGTH_VERSION_STRING bytes as required by the API.
        let rc = unsafe { (self.can_get_error_text)(status, 0x00, buf.as_mut_ptr()) };
        if rc == PCAN_ERROR_OK {
            let cstr = unsafe { std::ffi::CStr::from_ptr(buf.as_ptr()) };
            format!("{} (0x{:X})", cstr.to_string_lossy(), status)
        } else {
            format!("PCAN error 0x{:X}", status)
        }
    }

    /// Read a u32 parameter for a channel.
    pub fn get_u32(&self, channel: u16, param: u8) -> Result<u32, u32> {
        let mut value: u32 = 0;
        let rc = unsafe {
            (self.can_get_value)(
                channel,
                param,
                &mut value as *mut u32 as *mut c_void,
                std::mem::size_of::<u32>() as u32,
            )
        };
        if rc == PCAN_ERROR_OK {
            Ok(value)
        } else {
            Err(rc)
        }
    }

    /// Read a string parameter for a channel.
    pub fn get_string(&self, channel: u16, param: u8, max_len: usize) -> Result<String, u32> {
        let mut buf = vec![0u8; max_len];
        let rc = unsafe {
            (self.can_get_value)(
                channel,
                param,
                buf.as_mut_ptr() as *mut c_void,
                max_len as u32,
            )
        };
        if rc == PCAN_ERROR_OK {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            Ok(String::from_utf8_lossy(&buf[..end]).trim().to_string())
        } else {
            Err(rc)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Struct layout must match the C header exactly (C default alignment).
    #[test]
    fn ffi_struct_layout() {
        assert_eq!(std::mem::size_of::<TPCANMsg>(), 16);
        assert_eq!(std::mem::offset_of!(TPCANMsg, msgtype), 4);
        assert_eq!(std::mem::offset_of!(TPCANMsg, len), 5);
        assert_eq!(std::mem::offset_of!(TPCANMsg, data), 6);
        assert_eq!(std::mem::size_of::<TPCANTimestamp>(), 8);
        assert_eq!(std::mem::offset_of!(TPCANTimestamp, millis_overflow), 4);
        assert_eq!(std::mem::offset_of!(TPCANTimestamp, micros), 6);
    }

    #[test]
    fn timestamp_math() {
        let ts = TPCANTimestamp {
            millis: 2,
            millis_overflow: 0,
            micros: 500,
        };
        assert_eq!(ts.total_micros(), 2_500);
        let ts = TPCANTimestamp {
            millis: 0,
            millis_overflow: 1,
            micros: 0,
        };
        assert_eq!(ts.total_micros(), 0x1_0000_0000u64 * 1000);
    }

    /// Loading is a no-op assertion when the library isn't installed (CI-safe).
    #[test]
    fn loads_if_present() {
        match PcbusbApi::get() {
            Ok(api) => {
                // If the library is present, the error-text path must work.
                let text = api.error_text(PCAN_ERROR_QRCVEMPTY);
                assert!(!text.is_empty());
            }
            Err(e) => {
                assert!(e.contains("PCAN driver library not found"));
            }
        }
    }
}
