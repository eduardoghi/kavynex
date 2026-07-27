use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};

use crate::services::database::{database_path, Db};
use crate::services::db_backup::{self, DatabaseBackupStatus, DatabaseIntegrityReport};
use crate::utils::path::{extension_from_path, is_network_path};
use crate::utils::task::run_blocking;
use crate::{AppError, AppErrorCode, AppResult};

/// The file extensions a database may be exported to or imported from. One list, shared by both
/// directions, so the gate on the way out and the gate on the way in cannot drift apart. Both
/// dialogs filter to `.db` alone, so this is deliberately wider than either legitimate flow.
const DATABASE_FILE_EXTENSIONS: [&str; 3] = ["db", "sqlite", "sqlite3"];

fn has_database_extension(path: &str) -> bool {
    let extension = extension_from_path(Path::new(path));

    DATABASE_FILE_EXTENSIONS.contains(&extension.as_str())
}

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

    if !has_database_extension(trimmed) {
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

/// Validates a caller-provided export destination and returns the exact path the export must be
/// written to.
///
/// Extracted from `export_database` as a pure function (the caller resolves `config_dir` from the
/// `AppHandle` first) so the ordering it enforces is unit-testable without a live app: trim once,
/// then the extension gate, then the app-config-dir containment refusal - all against the *same*
/// trimmed path, and the returned `PathBuf` is that same path. That single-path invariant is the
/// point: the earlier inline version gated the extension/containment on the trimmed path while the
/// write used the raw one, so a padded destination could be validated on one path and written to
/// another - a validate-here/act-there gap in a function whose whole job is to gate a destructive
/// overwrite.
fn prepare_export_destination(destination_path: &str, config_dir: &Path) -> AppResult<PathBuf> {
    let trimmed = destination_path.trim();

    validate_export_destination(trimmed)?;

    // Refuse an export aimed inside the app's own config directory, where the live database and
    // every backup generation live: replacing one of those with an export is a data-loss path the
    // shared `.db` extension would otherwise let through (see destination_is_inside_dir).
    if destination_is_inside_dir(Path::new(trimmed), config_dir) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "the export cannot be written into the app's own data directory, which holds the live database and its backups",
        ));
    }

    Ok(PathBuf::from(trimmed))
}

/// Validates the caller-provided import source and returns the exact path the staging copy must
/// read. The mirror image of [`prepare_export_destination`] on the way in: the import replaces the
/// live database on the next startup, so its *input* deserves the same gate its output already had.
///
/// Two things are enforced, each closing a gap the export side never had:
///
/// - **No network location.** `stage_database_import` stats and then opens this path, and on
///   Windows merely stat'ing a UNC share authenticates to that host over SMB, leaking the user's
///   NTLM hash. This value arrives raw over IPC, so the refusal belongs here rather than resting on
///   the file picker - the same guard, for the same reason, as
///   `library::resolve_path_inside_library` and `yt_dlp_cookies::normalize_cookies_path`. Importing
///   a database off a share still works; it just has to be copied locally first, which the staging
///   copy does anyway.
/// - **A database file extension.** Not a security boundary on its own (the source is only read,
///   and `validate_import_source` still has to recognize it as a kavynex database), but it turns a
///   mistyped or hostile path into a clear refusal instead of an "is this a valid SQLite file?"
///   probe of an arbitrary path on disk.
///
/// It lives here rather than inside `stage_database_import` on purpose: the undo path
/// (`db_backup::stage_database_import_undo`) reuses that function with the `.pre-import` snapshot,
/// whose extension this gate would reject. Keeping the gate on the caller-facing command leaves the
/// undo - whose source the backend wrote itself and never took from IPC - untouched.
///
/// Returns the trimmed path so the guard and the read act on exactly one value, the same
/// single-path invariant `prepare_export_destination` documents.
fn prepare_import_source(source_path: &str) -> AppResult<PathBuf> {
    let trimmed = source_path.trim();

    if trimmed.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "import source path is empty",
        ));
    }

    if is_network_path(trimmed) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "a database on a network location cannot be imported; copy it to a local folder first",
        ));
    }

    if !has_database_extension(trimmed) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "database import must select a .db, .sqlite or .sqlite3 file",
        ));
    }

    Ok(PathBuf::from(trimmed))
}

/// The guard `restore_database_from_backup` applies before touching the database file: a restore
/// renames the live database aside, so it must never run while the pool is open (which would be
/// operating on a file being renamed underneath). Extracted so both branches are unit-testable
/// without a live pool; `is_open` is `Db::is_initialized`, re-read under the restore lock.
fn ensure_closed_before_restore(is_open: bool) -> AppResult<()> {
    if is_open {
        return Err(AppError::from_code(
            AppErrorCode::DatabaseAlreadyOpen,
            "the database is already open; restart the app before restoring from backup",
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
    let db = app.try_state::<Db>().ok_or_else(|| {
        AppError::from_code(AppErrorCode::AppError, "the database is not initialized")
    })?;

    // Hold the open lock for the whole restore so no concurrent command can open the pool - which
    // creates/renames the database file - while the restore renames it underneath. The
    // already-open check is re-done under the lock: the pool may have opened between the frontend's
    // recovery entry and this command acquiring the lock.
    let _open_guard = db.restore_guard().await;

    ensure_closed_before_restore(db.is_initialized())?;

    let path = database_path(&app)?;
    db_backup::restore_database_from_backup(&path).await
}

/// Exports a consistent snapshot of the database to a user-chosen path. Portable, so it can
/// be kept off-machine or moved to another install (unlike the internal corruption-recovery
/// backup, which lives next to the live database).
#[tauri::command]
pub async fn export_database(app: AppHandle, destination_path: String) -> AppResult<()> {
    // The AppHandle-bound half: resolve the app config directory the containment guard needs. The
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

/// Validates and stages a user-provided database file for import. The swap is applied on the
/// next startup, so the caller should relaunch the app after this succeeds.
#[tauri::command]
pub async fn import_database(app: AppHandle, source_path: String) -> AppResult<()> {
    // Gate the caller-supplied source before anything stats or opens it (see
    // prepare_import_source), and read from exactly the path it returns.
    let source = prepare_import_source(&source_path)?;

    let path = database_path(&app)?;
    db_backup::stage_database_import(&path, &source).await
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
        let protected = std::env::temp_dir().join(format!(
            "kavynex-export-guard-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&protected).unwrap();

        // A destination directly inside the protected directory (e.g. overwriting kavynex.db.bak).
        let inside = protected.join("kavynex.db.bak");
        assert!(destination_is_inside_dir(&inside, &protected));

        // A destination in a sibling directory is not inside it, even though its name is a prefix.
        // Built by extending `protected`'s own name rather than from a second unique suffix, which
        // would not share that prefix - and the prefix is the whole point of this assertion.
        let sibling = protected.with_file_name(format!(
            "{}-elsewhere",
            protected.file_name().unwrap().to_string_lossy()
        ));
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

    fn unique_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-prepare-export-{tag}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn prepare_export_destination_returns_the_trimmed_path_outside_the_config_dir() {
        let config_dir = unique_dir("config");
        let outside_dir = unique_dir("outside");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&outside_dir).unwrap();

        let destination = outside_dir.join("backup.db");
        // Padded input: the returned path must be the *trimmed* destination. This pins the
        // single-path invariant - the guard and the write both act on exactly this path - so the
        // validate-here/act-there regression (gate the trimmed path, write the raw one) stays dead.
        let padded = format!("   {}   ", destination.to_string_lossy());

        let prepared = prepare_export_destination(&padded, &config_dir).unwrap();
        assert_eq!(prepared, destination);

        let _ = std::fs::remove_dir_all(&config_dir);
        let _ = std::fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn prepare_export_destination_rejects_a_target_inside_the_config_dir() {
        let config_dir = unique_dir("inside");
        std::fs::create_dir_all(&config_dir).unwrap();

        // A .db target directly inside the config dir passes the extension gate but must still be
        // refused: it could clobber the live kavynex.db or one of its backup generations.
        let inside = config_dir.join("kavynex.db.bak");
        let error = prepare_export_destination(&inside.to_string_lossy(), &config_dir).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());

        let _ = std::fs::remove_dir_all(&config_dir);
    }

    #[test]
    fn prepare_export_destination_rejects_a_non_database_extension_before_containment() {
        // The extension gate runs before the containment check, so a non-database target is rejected
        // regardless of the config dir (a nonexistent path here is enough to prove the ordering).
        let config_dir = unique_dir("nonexistent");

        let error =
            prepare_export_destination("C:/Users/victim/contract.docx", &config_dir).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());
    }

    #[test]
    fn prepare_import_source_returns_the_trimmed_path_for_every_database_extension() {
        for name in ["backup.db", "backup.sqlite", "backup.sqlite3", "BACKUP.DB"] {
            let source = unique_dir("import").join(name);
            // Padded input: the returned path must be the *trimmed* source, so the guard and the
            // read act on one value - the same single-path invariant the export side pins.
            let padded = format!("   {}   ", source.to_string_lossy());

            let prepared = prepare_import_source(&padded)
                .unwrap_or_else(|error| panic!("{name} should be accepted: {error}"));
            assert_eq!(prepared, source);
        }
    }

    #[test]
    fn prepare_import_source_rejects_a_network_location() {
        // stage_database_import stats and opens this path; on Windows a UNC share authenticates
        // over SMB on the stat alone and leaks the user's NTLM hash. Every spelling Windows
        // resolves to a share is covered, and each one carries a valid `.db` extension so only
        // the network check can be what rejects it.
        for value in [
            r"\\evil\share\library.db",
            "//evil/share/library.db",
            r"/\evil\share\library.db",
            r"\/evil\share\library.db",
            r"\\?\UNC\evil\share\library.db",
        ] {
            let error = prepare_import_source(value)
                .expect_err(&format!("{value} should be rejected as a network path"));
            assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());
            assert!(
                error.message.contains("network location"),
                "the refusal should name the reason: {}",
                error.message
            );
        }
    }

    #[test]
    fn prepare_import_source_rejects_empty_and_non_database_sources() {
        let empty = prepare_import_source("   ").unwrap_err();
        assert_eq!(empty.code, AppErrorCode::InvalidTargetPath.as_str());

        // An arbitrary file must not be probed as a candidate database.
        for path in [
            "C:/Users/victim/Documents/contract.docx",
            "/home/victim/.ssh/id_rsa",
            "no-extension",
        ] {
            let error =
                prepare_import_source(path).expect_err(&format!("{path} should be rejected"));
            assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());
        }
    }

    #[test]
    fn prepare_import_source_rejects_the_undo_snapshot_the_command_never_sees() {
        // The undo path (db_backup::stage_database_import_undo) reuses stage_database_import with
        // the `.pre-import` snapshot, whose extension this gate rejects. That is exactly why the
        // gate lives on the command rather than inside stage_database_import: putting it there
        // would have broken the undo silently. This pins the incompatibility, so a later move of
        // the check into the service layer fails here instead of at a user's next undo.
        let snapshot = unique_dir("undo").join("kavynex.db.pre-import");

        let error = prepare_import_source(&snapshot.to_string_lossy()).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());
    }

    #[test]
    fn the_export_and_import_gates_accept_the_same_extensions() {
        // Both directions read DATABASE_FILE_EXTENSIONS, so they cannot drift apart. Asserting it
        // is what keeps a future change to one gate from quietly widening or narrowing only that
        // side - the import gate is the newer of the two and the likelier one to be edited alone.
        for extension in DATABASE_FILE_EXTENSIONS {
            let candidate = unique_dir("parity").join(format!("db.{extension}"));
            let candidate = candidate.to_string_lossy().to_string();

            validate_export_destination(&candidate)
                .unwrap_or_else(|error| panic!(".{extension} should export: {error}"));
            prepare_import_source(&candidate)
                .unwrap_or_else(|error| panic!(".{extension} should import: {error}"));
        }
    }

    #[test]
    fn ensure_closed_before_restore_rejects_an_open_database() {
        let error = ensure_closed_before_restore(true).unwrap_err();
        assert_eq!(error.code, AppErrorCode::DatabaseAlreadyOpen.as_str());
    }

    #[test]
    fn ensure_closed_before_restore_allows_a_closed_database() {
        assert!(ensure_closed_before_restore(false).is_ok());
    }
}
