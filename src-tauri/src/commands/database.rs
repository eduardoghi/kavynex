use std::path::Path;

use tauri::AppHandle;

use crate::services::database::{database_path, is_pool_initialized, shared_pool};
use crate::services::db_backup::{self, DatabaseBackupStatus};
use crate::utils::path::extension_from_path;
use crate::{AppError, AppErrorCode, AppResult};

/// Validates the caller-provided export destination. `export_database` unconditionally removes
/// and replaces the file at this path, so accepting an arbitrary string would let a compromised
/// frontend overwrite any writable file (a document, a key) with the exported database. The
/// backend cannot see the save dialog, so it enforces a database file extension here; the export
/// UI always targets a `.db` file, so this never rejects a legitimate export.
fn validate_export_destination(destination_path: &str) -> AppResult<()> {
    let trimmed = destination_path.trim();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "export destination path is empty",
        ));
    }

    let extension = extension_from_path(Path::new(trimmed));

    if !matches!(extension.as_str(), "db" | "sqlite" | "sqlite3") {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "database export must target a .db, .sqlite or .sqlite3 file",
        ));
    }

    Ok(())
}

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
    if is_pool_initialized(&app) {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseAlreadyOpen,
            "the database is already open; restart the app before restoring from backup",
        ));
    }

    let path = database_path(&app)?;
    db_backup::restore_database_from_backup(&path).await
}

/// Exports a consistent snapshot of the database to a user-chosen path. Portable, so it can
/// be kept off-machine or moved to another install (unlike the internal corruption-recovery
/// backup, which lives next to the live database).
#[tauri::command]
pub async fn export_database(app: AppHandle, destination_path: String) -> AppResult<()> {
    validate_export_destination(&destination_path)?;

    let path = database_path(&app)?;
    db_backup::export_database(&path, Path::new(&destination_path)).await
}

/// Validates and stages a user-provided database file for import. The swap is applied on the
/// next startup, so the caller should relaunch the app after this succeeds.
#[tauri::command]
pub async fn import_database(app: AppHandle, source_path: String) -> AppResult<()> {
    let path = database_path(&app)?;
    db_backup::stage_database_import(&path, std::path::Path::new(&source_path)).await
}

/// Reports whether the last applied import can still be undone (a `.pre-import` snapshot of
/// the database from before that import exists). Lets the frontend offer a recovery path when
/// the wrong or an incompatible database was imported.
#[tauri::command]
pub async fn get_database_import_undo_status(app: AppHandle) -> AppResult<bool> {
    let path = database_path(&app)?;
    Ok(db_backup::database_import_undo_available(&path))
}

/// Reverts the last applied database import by staging the pre-import snapshot as a pending
/// import; the swap is applied on the next startup (reusing the import path so the live pool
/// is never swapped underneath), so the caller should relaunch the app after this succeeds.
#[tauri::command]
pub async fn undo_database_import(app: AppHandle) -> AppResult<()> {
    let path = database_path(&app)?;
    db_backup::stage_database_import_undo(&path).await
}

/// Runs a full `PRAGMA integrity_check` against the live database, a more thorough (and
/// slower) check than the `quick_check` used by the automatic health paths. User-triggered
/// from the Diagnostics dialog.
#[tauri::command]
pub async fn check_database_integrity(app: AppHandle) -> AppResult<bool> {
    let pool = shared_pool(&app).await?;
    db_backup::run_full_integrity_check(&pool).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_export_destination_accepts_database_extensions() {
        for path in [
            "kavynex-backup.db",
            "C:/Users/me/Documents/backup.sqlite",
            "/home/me/backup.sqlite3",
            "BACKUP.DB",
        ] {
            validate_export_destination(path)
                .unwrap_or_else(|error| panic!("{path} should be accepted: {error}"));
        }
    }

    #[test]
    fn validate_export_destination_rejects_empty_and_non_database_targets() {
        let empty = validate_export_destination("   ").unwrap_err();
        assert_eq!(empty.code, AppErrorCode::InvalidTargetPath.as_str());

        // A document, an executable, and an extensionless path must all be rejected so the
        // exported database cannot be written over an arbitrary file.
        for path in [
            "C:/Users/victim/Documents/contract.docx",
            "important.exe",
            "no-extension",
            "id_rsa",
        ] {
            let error = validate_export_destination(path)
                .expect_err(&format!("{path} should be rejected"));
            assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());
        }
    }
}
