use tauri::AppHandle;

use crate::services::database::{database_path, is_pool_initialized, shared_pool};
use crate::services::db_backup::{self, DatabaseBackupStatus};
use crate::{AppError, AppErrorCode, AppResult};

/// Initializes the shared database pool (creating and migrating the schema on first
/// call) and confirms the database is reachable. Called by the frontend on startup so
/// database initialization errors surface to the user before any feature runs.
#[tauri::command]
pub async fn ensure_database_ready(app: AppHandle) -> AppResult<()> {
    shared_pool(&app).await?;
    Ok(())
}

/// Reports whether a database backup exists that could be restored, and when it was taken.
/// Used to offer recovery when `ensure_database_ready` fails.
#[tauri::command]
pub async fn get_database_backup_status(app: AppHandle) -> AppResult<DatabaseBackupStatus> {
    let path = database_path(&app)?;
    Ok(db_backup::database_backup_status(&path))
}

/// Restores the database from the most recent healthy backup, moving the corrupt database
/// aside. Only valid while the database is closed (after a failed open), so it refuses to
/// run once the pool is already initialized.
#[tauri::command]
pub async fn restore_database_from_backup(app: AppHandle) -> AppResult<()> {
    if is_pool_initialized() {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseAlreadyOpen,
            "the database is already open; restart the app before restoring from backup",
        ));
    }

    let path = database_path(&app)?;
    db_backup::restore_database_from_backup(&path).await
}
