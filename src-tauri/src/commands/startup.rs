use crate::services::startup_notices::{self, StartupNotices};

/// Takes what the startup tasks found for the user, clearing it. See `services::startup_notices`.
#[tauri::command]
pub fn take_startup_notices() -> StartupNotices {
    startup_notices::take()
}
