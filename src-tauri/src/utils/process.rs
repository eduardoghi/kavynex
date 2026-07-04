//! Helpers for spawning child processes without a flashing console window on Windows.
//!
//! The app is built with the `windows` subsystem (no console of its own), so spawning a
//! console child (`yt-dlp`, `ffmpeg`, `where.exe`, `taskkill`, ...) makes Windows allocate
//! and briefly show a console window. Passing `CREATE_NO_WINDOW` suppresses it. Both
//! helpers are no-ops on non-Windows platforms.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppresses the console window for a synchronous [`std::process::Command`].
#[cfg(windows)]
pub fn hide_console(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console(_command: &mut std::process::Command) {}

/// Suppresses the console window for an async [`tokio::process::Command`].
#[cfg(windows)]
pub fn hide_console_async(command: &mut tokio::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_console_async(_command: &mut tokio::process::Command) {}
