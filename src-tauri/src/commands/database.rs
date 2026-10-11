use std::path::Path;

use tauri::{AppHandle, Manager, Runtime, State};

use crate::services::chosen_files::{self, ChosenFile};
use crate::services::database::{database_path, get_app_settings_from_pool, Db};
use crate::services::db_backup::gates::{
    imported_library_is_usable, imported_mirror_is_usable, machine_setting_after_import,
    prepare_export_destination, prepare_import_source,
};
use crate::services::db_backup::{
    self, DatabaseBackupStatus, DatabaseCompaction, DatabaseIntegrityReport, MachinePaths,
};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// The guard `restore_database_from_backup` applies before touching the database file: a restore
/// renames the live database aside, so it must never run while the pool is open (which would be
/// operating on a file being renamed underneath). Extracted so both branches are unit-testable
/// without a live pool. `is_open` is `Db::is_initialized`, re-read under the restore lock.
///
/// The only caller is the recovery modal `use-app-bootstrap.ts` opens after `ensure_database_ready`
/// failed. An open pool then means the database opened after all, because the failure was transient
/// (a lock held by an antivirus scan) and a background task that opens the pool on its own got in
/// afterwards. Restoring would replace a working database with an older snapshot, so the message
/// says there is nothing to restore rather than asking for a restart.
fn ensure_closed_before_restore(is_open: bool) -> AppResult<()> {
    if is_open {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseAlreadyOpen,
            "the database opened successfully after the failed startup attempt, so there is \
             nothing to restore. Close this dialog and keep using the app. Your data is intact",
        ));
    }

    Ok(())
}

/// The guard `start_with_empty_database` applies. Starting over is only for a database file that is
/// missing and was never opened in this run.
fn ensure_database_is_missing(is_open: bool, file_exists: bool) -> AppResult<()> {
    ensure_closed_before_restore(is_open)?;

    if file_exists {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseAlreadyOpen,
            "the database file is there again, so there is nothing to start over from. Restart \
             Kavynex to open it",
        ));
    }

    Ok(())
}

/// Initializes the shared database pool (creating and migrating the schema on first
/// call) and confirms the database is reachable. Called by the frontend on startup so
/// database initialization errors surface to the user before any feature runs.
#[tauri::command]
pub async fn ensure_database_ready(db: State<'_, Db>) -> AppResult<()> {
    db.pool().await?;
    Ok(())
}

/// Opens a new, empty database in place of a missing one whose backups are still on disk, because
/// the user chose to start over rather than restore.
///
/// The backups are moved into `set-aside-backups/` first (see
/// `db_backup::set_aside_backups_for_empty_start`). Left in place, the new database's own daily
/// snapshot would rotate them out once it holds anything, and the restore cannot reach them once the
/// pool is open. The swap is recorded too, so the orphan removal does not read every file of the old
/// library as unreferenced by the new database for the next 30 days.
///
/// Refused once the pool is open or the file is back (a drive that mounted late), since setting the
/// backups aside then takes them away from a database that is still there.
#[tauri::command]
pub async fn start_with_empty_database(db: State<'_, Db>) -> AppResult<()> {
    {
        // Released before the pool opens below, which takes the same lock.
        let _open_guard = db.restore_guard().await;
        ensure_database_is_missing(db.is_initialized(), db.path().exists())?;

        let db_path = db.path().to_path_buf();
        run_blocking(move || {
            crate::services::db_backup::set_aside_backups_for_empty_start(&db_path).map(|_| ())
        })
        .await?;

        db.allow_creating_missing_database();
    }

    db.pool().await?;
    crate::services::db_backup::record_database_swap(db.path());
    Ok(())
}

/// Reports whether a database backup exists that could be restored, and when it was taken.
/// Used to offer recovery when `ensure_database_ready` fails.
#[tauri::command]
pub async fn get_database_backup_status<R: Runtime>(
    app: AppHandle<R>,
) -> AppResult<DatabaseBackupStatus> {
    // database_path (create_dir_all) and database_backup_status (read_dir + stat of each backup
    // generation) are blocking filesystem calls, so run them off the async runtime's worker
    // threads, consistent with the other filesystem commands.
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
pub async fn restore_database_from_backup<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    let db = app.try_state::<Db>().ok_or_else(|| {
        AppError::from_code(AppErrorCode::AppError, "the database is not initialized")
    })?;

    // Hold the open lock for the whole restore so no concurrent command can open the pool (which
    // creates/renames the database file), while the restore renames it underneath. The
    // already-open check is re-done under the lock. The pool may have opened between the frontend's
    // recovery entry and this command acquiring the lock.
    let _open_guard = db.restore_guard().await;

    ensure_closed_before_restore(db.is_initialized())?;

    let path = database_path(&app)?;
    db_backup::restore_database_from_backup(&path).await?;

    // A snapshot can be older than the library folder, which the same check after an import is
    // there to say. Run once the frontend has reloaded onto the restored database.
    crate::spawn_post_import_library_check(app.clone());

    Ok(())
}

/// Exports a consistent snapshot of the database to a user-chosen path. Portable, so it can
/// be kept off-machine or moved to another install (unlike the internal corruption-recovery
/// backup, which lives next to the live database).
#[tauri::command]
pub async fn export_database<R: Runtime>(
    app: AppHandle<R>,
    destination_path: String,
) -> AppResult<()> {
    chosen_files::ensure_chosen(ChosenFile::Destination, &destination_path)?;

    // The AppHandle-bound half. Resolve the app config directory the containment guard needs. The
    // validation ordering and the single-path invariant then live in the pure
    // prepare_export_destination (unit-tested), which returns the exact path the write uses.
    let config_dir = app.path().app_config_dir().map_err(|error| {
        AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            format!("failed to resolve the app data directory: {error}"),
        )
    })?;

    let destination = prepare_export_destination(&destination_path, &config_dir)?;

    let path = database_path(&app)?;
    db_backup::export_database(&path, &destination).await
}

/// This machine's library and mirror folders, as an import should carry them over.
///
/// The live settings are read through the pool when it opens. It does not when the import comes
/// from the startup recovery prompt, and then the file's own values are taken only where they are
/// valid here, which is the same rule as an unconfigured setting.
async fn machine_paths_for_import<R: Runtime>(
    app: &AppHandle<R>,
    db_path: &Path,
    imported_file: &Path,
) -> MachinePaths {
    let local = match app.try_state::<Db>() {
        Some(db) => match db.pool().await {
            Ok(pool) => get_app_settings_from_pool(&pool).await.ok(),
            Err(_) => None,
        },
        None => None,
    };

    let local = MachinePaths {
        library_path: local
            .as_ref()
            .and_then(|settings| settings.library_path.clone())
            .unwrap_or_default(),
        external_backup_dir: local
            .as_ref()
            .and_then(|settings| settings.external_backup_dir.clone())
            .unwrap_or_default(),
    };

    let imported = db_backup::read_machine_paths(imported_file)
        .await
        .unwrap_or_default();
    let config_dir = db_path.parent().map(Path::to_path_buf);

    let validity = {
        let imported = imported.clone();
        run_blocking(move || {
            let config_dir = config_dir.as_deref();
            Ok((
                imported_library_is_usable(&imported.library_path, config_dir),
                imported_mirror_is_usable(&imported.external_backup_dir, config_dir),
            ))
        })
        .await
    };
    let (library_ok, mirror_ok) = validity.unwrap_or((false, false));

    MachinePaths {
        library_path: machine_setting_after_import(
            &local.library_path,
            &imported.library_path,
            library_ok,
        ),
        external_backup_dir: machine_setting_after_import(
            &local.external_backup_dir,
            &imported.external_backup_dir,
            mirror_ok,
        ),
    }
}

/// Folds the live database's write-ahead log into the main file before an import is staged.
///
/// The swap on the next launch sets the current database aside as the undo snapshot by renaming
/// the `.db` alone and deletes its `-wal`, so commits still in the log at that point were missing
/// from the snapshot an undo would bring back. Best effort. A pool that is not open has no log
/// worth folding (it is the recovery prompt's case, where the open failed).
async fn checkpoint_live_database<R: Runtime>(app: &AppHandle<R>) {
    if !crate::services::database::is_pool_initialized(app) {
        return;
    }

    if let Ok(pool) = crate::services::database::shared_pool(app).await {
        if let Err(error) = crate::services::database::checkpoint_wal(&pool).await {
            crate::services::logger::warn(
                "db_import",
                format!("could not fold the write-ahead log in before staging an import: {error}"),
            );
        }
    }
}

/// Validates and stages a user-provided database file for import. The swap is applied on the
/// next startup, so the caller should relaunch the app after this succeeds.
#[tauri::command]
pub async fn import_database<R: Runtime>(app: AppHandle<R>, source_path: String) -> AppResult<()> {
    chosen_files::ensure_chosen(ChosenFile::Source, &source_path)?;

    // Gate the caller-supplied source before anything stats or opens it (see
    // prepare_import_source), and read from exactly the path it returns.
    let source = prepare_import_source(&source_path)?;

    let path = database_path(&app)?;
    let machine_paths = machine_paths_for_import(&app, &path, &source).await;

    checkpoint_live_database(&app).await;

    db_backup::stage_database_import(&path, &source, Some(&machine_paths)).await
}

/// Reports whether the last applied import can still be undone (a `.pre-import` snapshot of
/// the database from before that import exists). Lets the frontend offer a recovery path when
/// the wrong or an incompatible database was imported.
#[tauri::command]
pub async fn get_database_import_undo_status<R: Runtime>(app: AppHandle<R>) -> AppResult<bool> {
    // database_path (create_dir_all) and database_import_undo_available (a stat) are blocking
    // filesystem calls, so run them off the async runtime's worker threads.
    run_blocking(move || {
        let path = database_path(&app)?;
        Ok(db_backup::database_import_undo_available(&path))
    })
    .await
}

/// Reverts the last applied database import by staging the pre-import snapshot as a pending
/// import. That swap is applied on the next startup (reusing the import path so the live pool
/// is never swapped underneath), so the caller should relaunch the app after this succeeds.
#[tauri::command]
pub async fn undo_database_import<R: Runtime>(app: AppHandle<R>) -> AppResult<()> {
    let path = database_path(&app)?;
    let machine_paths =
        machine_paths_for_import(&app, &path, &db_backup::pre_import_path(&path)).await;

    checkpoint_live_database(&app).await;

    db_backup::stage_database_import_undo(&path, Some(&machine_paths)).await
}

/// Runs a full `PRAGMA integrity_check` against the live database, a more thorough (and
/// slower) check than the `quick_check` used by the automatic health paths. User-triggered
/// from the Diagnostics dialog. Returns what SQLite reported, not just whether it passed, so a
/// failing check can say what is damaged rather than only that something is.
#[tauri::command]
pub async fn check_database_integrity(db: State<'_, Db>) -> AppResult<DatabaseIntegrityReport> {
    let pool = db.pool().await?;
    let report = db_backup::run_full_integrity_check(&pool).await?;
    record_integrity_check(&db, &report);

    Ok(report)
}

/// Rebuilds the live database's indexes and checks it again (see `db_backup::rebuild_indexes`).
/// Offered by the Diagnostics dialog when a check found damage, since damage limited to an index is
/// fixed this way without restoring a backup.
#[tauri::command]
pub async fn rebuild_database_indexes(db: State<'_, Db>) -> AppResult<DatabaseIntegrityReport> {
    let pool = db.pool().await?;
    let report = db_backup::rebuild_indexes(&pool).await?;
    record_integrity_check(&db, &report);

    Ok(report)
}

/// The same bookkeeping as the weekly background check, so a check the user ran stops (or resumes)
/// the daily backup's rotation the same way. A test database has no path to write to.
fn record_integrity_check(db: &Db, report: &DatabaseIntegrityReport) {
    if db.path().as_os_str().is_empty() {
        return;
    }

    if report.ok {
        db_backup::mark_integrity_check_passed(db.path());
    } else {
        db_backup::mark_integrity_check_failed(db.path());
    }
}

/// Rewrites the live database without the space deleted rows left behind. User-triggered from the
/// Diagnostics dialog, never automatic, because it reads and rewrites the whole file.
#[tauri::command]
pub async fn compact_database(db: State<'_, Db>) -> AppResult<DatabaseCompaction> {
    let pool = db.pool().await?;
    db_backup::compact_database(&pool, db.path()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_ipc::{invoke, memory_db};
    use std::path::PathBuf;
    use tauri::test::{mock_builder, mock_context, noop_assets};
    use tauri::Manager;

    fn test_webview(db: Db) -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = mock_builder()
            .invoke_handler(tauri::generate_handler![
                ensure_database_ready,
                check_database_integrity,
                rebuild_database_indexes
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
    fn rebuild_database_indexes_command_reports_the_check_after_it_over_ipc() {
        let webview = test_webview(memory_db());

        let report = invoke(&webview, "rebuild_database_indexes", serde_json::json!({}))
            .unwrap()
            .deserialize::<serde_json::Value>()
            .unwrap();

        assert_eq!(
            report,
            serde_json::json!({ "ok": true, "problems": [], "truncated": false })
        );
    }

    /// A mock app managing a real on-disk database in its own directory, opened and migrated, with
    /// `library_path` set to `library`.
    async fn app_with_live_database(
        label: &str,
        library: &str,
    ) -> (tauri::App<tauri::test::MockRuntime>, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "kavynex-import-{label}-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("kavynex.db");

        let db = Db::new(path.clone());
        let pool = db.pool().await.unwrap();
        crate::services::database::set_app_settings_in_pool(
            &pool,
            &crate::services::database::StoredAppSettings {
                library_path: Some(library.to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        app.manage(db);

        (app, path)
    }

    #[tokio::test]
    async fn an_import_reads_this_machines_folders_from_the_live_database() {
        let (app, path) = app_with_live_database("machine-paths", "C:/This machine").await;

        // The imported file is the live one here, so its own value is the same. What matters is
        // that the live setting comes through rather than nothing.
        let paths = machine_paths_for_import(app.handle(), &path, &path).await;

        assert_eq!(paths.library_path, "C:/This machine");
        assert_eq!(paths.external_backup_dir, "");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn staging_an_import_folds_the_live_write_ahead_log_in_first() {
        let (app, path) = app_with_live_database("checkpoint", "C:/Library").await;
        let wal = path.with_file_name("kavynex.db-wal");
        assert!(
            std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0) > 0,
            "the settings write must still be in the log for this to test anything"
        );

        checkpoint_live_database(app.handle()).await;

        assert_eq!(std::fs::metadata(&wal).unwrap().len(), 0);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn ensure_closed_before_restore_rejects_an_open_database() {
        let error = ensure_closed_before_restore(true).unwrap_err();
        assert_eq!(error.code, AppErrorCode::DatabaseAlreadyOpen.as_str());
    }

    #[test]
    fn the_refusal_tells_the_user_there_is_nothing_to_restore_rather_than_to_restart() {
        // The only caller is the recovery modal, so reaching this refusal means the database
        // recovered on its own between the failed startup check and the click. The message it
        // carries is the whole user-facing value of this branch, and the previous one instructed
        // the opposite of the right action ("restart the app before restoring from backup"),
        // which would have the user restart, find the app working, and never learn whether a
        // restore had happened. Asserted on the substance rather than on the exact sentence, so
        // rewording stays free and reinstating the restart instruction does not.
        let error = ensure_closed_before_restore(true).unwrap_err();

        assert!(
            error.message.contains("nothing to restore"),
            "the refusal must say the database needs no restore (got: {})",
            error.message
        );
        assert!(
            !error.message.contains("restart"),
            "the refusal must not tell the user to restart and restore a working database (got: {})",
            error.message
        );
    }

    #[test]
    fn ensure_closed_before_restore_allows_a_closed_database() {
        assert!(ensure_closed_before_restore(false).is_ok());
    }

    #[test]
    fn starting_over_needs_a_database_that_is_missing_and_closed() {
        assert!(ensure_database_is_missing(false, false).is_ok());

        for (is_open, file_exists) in [(true, false), (false, true), (true, true)] {
            let error = ensure_database_is_missing(is_open, file_exists).unwrap_err();
            assert_eq!(error.code, AppErrorCode::DatabaseAlreadyOpen.as_str());
        }
    }
}
