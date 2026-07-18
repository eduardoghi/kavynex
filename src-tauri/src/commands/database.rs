use std::path::Path;

use tauri::{AppHandle, Manager, State};

use crate::services::database::{database_path, is_pool_initialized, Db};
use crate::services::db_backup::{self, DatabaseBackupStatus, DatabaseIntegrityReport};
use crate::utils::path::extension_from_path;
use crate::utils::task::run_blocking;
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

/// True when `destination`'s directory resolves inside `protected_dir`. `export_database` removes
/// and replaces the file at the destination, and the app's config directory holds the live
/// `kavynex.db` plus every backup generation (`.bak`, `.corrupt`, `.pre-import`, ...), so an export
/// aimed there - by a compromised frontend, or a user who navigated the save dialog into it - could
/// clobber the live database or a recovery snapshot with a fresh export. The extension gate alone
/// would allow that (they share the `.db` extension); this refuses it.
///
/// Compares canonical paths so a symlink or a `..`-laden path cannot dodge the check. The
/// destination file need not exist yet (it is a save target), so its parent directory is
/// canonicalized instead; a parent that cannot be canonicalized is treated as *not* inside
/// (fail open), because the export would fail later on that path anyway and rejecting a legitimate
/// destination on a canonicalize error would be worse than leaving the extension gate as the guard.
fn destination_is_inside_dir(destination: &Path, protected_dir: &Path) -> bool {
    let Ok(canonical_protected) = protected_dir.canonicalize() else {
        return false;
    };

    let Some(parent) = destination.parent() else {
        return false;
    };

    match parent.canonicalize() {
        Ok(canonical_parent) => canonical_parent.starts_with(&canonical_protected),
        Err(_) => false,
    }
}

/// Initializes the shared database pool (creating and migrating the schema on first
/// call) and confirms the database is reachable. Called by the frontend on startup so
/// database initialization errors surface to the user before any feature runs.
#[tauri::command]
pub async fn ensure_database_ready(db: State<'_, Db>) -> AppResult<()> {
    db.pool().await?;
    Ok(())
}

/// Reports whether a database backup exists that could be restored, and when it was taken.
/// Used to offer recovery when `ensure_database_ready` fails.
#[tauri::command]
pub async fn get_database_backup_status(app: AppHandle) -> AppResult<DatabaseBackupStatus> {
    // database_path (create_dir_all) and database_backup_status (read_dir + stat of each backup
    // generation) are blocking filesystem calls; run them off the async runtime's worker threads,
    // consistent with the other filesystem commands.
    run_blocking(move || {
        let path = database_path(&app)?;
        Ok(db_backup::database_backup_status(&path))
    })
    .await
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

    // Refuse an export aimed inside the app's own config directory, where the live database and
    // every backup generation live: replacing one of those with an export is a data-loss path the
    // shared `.db` extension would otherwise let through (see destination_is_inside_dir).
    let config_dir = app.path().app_config_dir().map_err(|error| {
        AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            format!("failed to resolve the app data directory: {error}"),
        )
    })?;

    if destination_is_inside_dir(Path::new(destination_path.trim()), &config_dir) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "the export cannot be written into the app's own data directory, which holds the live database and its backups",
        ));
    }

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
    // database_path (create_dir_all) and database_import_undo_available (a stat) are blocking
    // filesystem calls; run them off the async runtime's worker threads.
    run_blocking(move || {
        let path = database_path(&app)?;
        Ok(db_backup::database_import_undo_available(&path))
    })
    .await
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
/// from the Diagnostics dialog. Returns what SQLite reported, not just whether it passed, so a
/// failing check can say what is damaged rather than only that something is.
#[tauri::command]
pub async fn check_database_integrity(db: State<'_, Db>) -> AppResult<DatabaseIntegrityReport> {
    let pool = db.pool().await?;
    db_backup::run_full_integrity_check(&pool).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                ensure_database_ready,
                check_database_integrity
            ])
            .build(mock_context(noop_assets()))
            .unwrap();

        app.manage(db);

        tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap()
    }

    #[test]
    fn ensure_database_ready_command_succeeds_over_ipc() {
        let webview = test_webview(memory_db());

        // A managed, openable database resolves the command to a unit success across IPC.
        invoke(&webview, "ensure_database_ready", serde_json::json!({})).unwrap();
    }

    #[test]
    fn check_database_integrity_command_reports_ok_over_ipc() {
        let webview = test_webview(memory_db());

        // Deserialized into the shape the frontend actually receives (camelCase over serde), so a
        // rename on the Rust side breaks here rather than silently at runtime.
        let report = invoke(&webview, "check_database_integrity", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();

        assert_eq!(
            report,
            serde_json::json!({ "ok": true, "problems": [], "truncated": false }),
            "a freshly migrated database should pass integrity_check with nothing to report"
        );
    }

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
    fn destination_is_inside_dir_detects_a_target_within_the_protected_directory() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let protected = std::env::temp_dir().join(format!("kavynex-export-guard-{nanos}"));
        std::fs::create_dir_all(&protected).unwrap();

        // A destination directly inside the protected directory (e.g. overwriting kavynex.db.bak).
        let inside = protected.join("kavynex.db.bak");
        assert!(destination_is_inside_dir(&inside, &protected));

        // A destination in a sibling directory is not inside it, even though its name is a prefix.
        let sibling = std::env::temp_dir().join(format!("kavynex-export-guard-{nanos}-elsewhere"));
        std::fs::create_dir_all(&sibling).unwrap();
        let outside = sibling.join("backup.db");
        assert!(!destination_is_inside_dir(&outside, &protected));

        let _ = std::fs::remove_dir_all(&protected);
        let _ = std::fs::remove_dir_all(&sibling);
    }

    #[test]
    fn destination_is_inside_dir_fails_open_when_the_parent_cannot_be_canonicalized() {
        // A destination whose parent directory does not exist cannot be confirmed as inside the
        // protected directory, so the guard must not reject it (the extension gate still applies).
        let protected = std::env::temp_dir();
        let missing_parent = protected.join("does-not-exist-kavynex").join("backup.db");
        assert!(!destination_is_inside_dir(&missing_parent, &protected));
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
            let error =
                validate_export_destination(path).expect_err(&format!("{path} should be rejected"));
            assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());
        }
    }
}
