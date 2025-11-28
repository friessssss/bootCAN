pub mod traits;
pub mod virtual_can;

#[cfg(target_os = "linux")]
pub mod socketcan;

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod pcan;

