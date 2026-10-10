//! The checks on a database file the user names for an export or an import, and on the folders an
//! imported database carries.
//!
//! Pure policy, so the commands in `commands/database.rs` and `commands/settings.rs` only resolve
//! what needs an `AppHandle` and call these.

use std::path::{Path, PathBuf};

use crate::services::library::paths::library_path_is_inside_dir;
use crate::utils::path::{extension_from_path, is_network_path, resolves_inside_dir};
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
/// backend cannot see the save dialog, so it enforces a database file extension here. The export
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
/// aimed there (by a compromised frontend, or a user who navigated the save dialog into it) could
/// clobber the live database or a recovery snapshot with a fresh export. The extension gate alone
/// would allow that (they share the `.db` extension), so this refuses it instead.
///
/// Compares canonical paths so a symlink or a `..`-laden path cannot dodge the check. The
/// destination file need not exist yet (it is a save target), so its parent directory is
/// canonicalized instead. A parent that cannot be canonicalized is treated as *not* inside
/// (fail open), because the export would fail later on that path anyway and rejecting a legitimate
/// destination on a canonicalize error would be worse than leaving the extension gate as the guard.
fn destination_is_inside_dir(destination: &Path, protected_dir: &Path) -> bool {
    destination
        .parent()
        .is_some_and(|parent| resolves_inside_dir(parent, protected_dir))
}

/// Validates a caller-provided export destination and returns the exact path the export must be
/// written to.
///
/// Extracted from `export_database` as a pure function (the caller resolves `config_dir` from the
/// `AppHandle` first) so the ordering it enforces is unit-testable without a live app. Trim once,
/// then the extension gate, then the network-location refusal, then the app-config-dir containment
/// refusal. All against the *same* trimmed path, and the returned `PathBuf` is that same path. The
/// network check has to precede the containment one because that one canonicalizes (see below).
/// That single-path invariant is the
/// point. The earlier inline version gated the extension/containment on the trimmed path while the
/// write used the raw one, so a padded destination could be validated on one path and written to
/// another. A validate-here/act-there gap in a function whose whole job is to gate a destructive
/// overwrite.
pub(crate) fn prepare_export_destination(
    destination_path: &str,
    config_dir: &Path,
) -> AppResult<PathBuf> {
    let trimmed = destination_path.trim();

    validate_export_destination(trimmed)?;

    // Refuse a network destination before anything touches it. Two things follow from a UNC path
    // here, and the write is the worse one. `destination_is_inside_dir` below canonicalizes the
    // destination's parent, and on Windows that alone authenticates to the host over SMB and hands
    // it the user's NTLM hash, and then the export writes the whole database (every channel,
    // title, comment and stored local path) to a host the caller chose. The mirror in
    // `db_backup::external.rs` calls the `export_database` *service* function rather than this
    // command, so an external backup folder on a share keeps working. Only the manual export has
    // to be written locally and copied from there, exactly as `prepare_import_source` requires on
    // the way in.
    if is_network_path(trimmed) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidTargetPath,
            "a database cannot be exported to a network location, so export it to a local folder and copy it from there",
        ));
    }

    // Refuse an export aimed inside the app's own config directory, where the live database and
    // every backup generation live. Replacing one of those with an export is a data-loss path the
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
/// read. The mirror image of [`prepare_export_destination`] on the way in. The import replaces the
/// live database on the next startup, so its *input* deserves the same gate its output already had.
///
/// Two things are enforced, each closing a gap the export side never had:
///
/// - **No network location.** `stage_database_import` stats and then opens this path, and on
///   Windows merely stat'ing a UNC share authenticates to that host over SMB, leaking the user's
///   NTLM hash. This value arrives raw over IPC, so the refusal belongs here rather than resting on
///   the file picker. The same guard, for the same reason, as
///   `library::resolve_path_inside_library` and `yt_dlp::cookies::normalize_cookies_path`. Importing
///   a database off a share still works, but it just has to be copied locally first, which the
///   staging copy does anyway.
/// - **A database file extension.** Not a security boundary on its own (the source is only read,
///   and `validate_import_source` still has to recognize it as a kavynex database), but it turns a
///   mistyped or hostile path into a clear refusal instead of an "is this a valid SQLite file?"
///   probe of an arbitrary path on disk.
///
/// It lives here rather than inside `stage_database_import` on purpose. The undo path
/// (`db_backup::stage_database_import_undo`) reuses that function with the `.pre-import` snapshot,
/// whose extension this gate would reject. Keeping the gate on the caller-facing command leaves the
/// undo (whose source the backend wrote itself and never took from IPC), untouched.
///
/// Returns the trimmed path so the guard and the read act on exactly one value, the same
/// single-path invariant `prepare_export_destination` documents.
pub(crate) fn prepare_import_source(source_path: &str) -> AppResult<PathBuf> {
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
            "a database on a network location cannot be imported, so copy it to a local folder first",
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

/// Which value a machine setting takes in an imported database.
///
/// This machine's own wins whenever it has one. When it has none (a fresh install restoring its own
/// export), the imported value is kept only if it passes here the same check `set_app_settings`
/// applies, and the setting is left unconfigured otherwise. Pure, because it decides what the
/// library guard trusts from the next launch on.
pub(crate) fn machine_setting_after_import(
    local: &str,
    imported: &str,
    imported_is_valid_here: bool,
) -> String {
    let local = local.trim();

    if !local.is_empty() {
        return local.to_string();
    }

    if imported_is_valid_here {
        imported.trim().to_string()
    } else {
        String::new()
    }
}

/// The imported folder to check on disk, or `None` when it is refused without touching anything.
///
/// Empty means unconfigured. A network path is refused here, before any `stat`, because resolving
/// one authenticates to whatever host the imported file names.
fn imported_folder_to_check(path: &str) -> Option<&str> {
    let path = path.trim();

    if path.is_empty() || is_network_path(path) {
        None
    } else {
        Some(path)
    }
}

/// Whether a library folder named by an imported database may be taken on this machine.
///
/// The file is not trusted, so the folder has to pass the check `set_app_settings` makes and also
/// already hold one of the managed directories, which a folder really used as a Kavynex library
/// does. Without that, any file could point the library, and the cleanup that runs in it, at an
/// arbitrary existing folder.
pub(crate) fn imported_library_is_usable(path: &str, config_dir: Option<&Path>) -> bool {
    let Some(path) = imported_folder_to_check(path) else {
        return false;
    };

    crate::services::library::paths::validate_settings_library_path(path, config_dir).is_ok()
        && crate::constants::MANAGED_LIBRARY_DIRS
            .iter()
            .any(|dir| Path::new(path).join(dir).is_dir())
}

/// Whether a mirror folder named by an imported database may be taken on this machine.
///
/// Same reasoning as [`imported_library_is_usable`]. The folder must already hold the mirror
/// file, so an imported value cannot make the daily mirror start writing into a folder of the
/// file's choosing.
pub(crate) fn imported_mirror_is_usable(path: &str, config_dir: Option<&Path>) -> bool {
    let Some(path) = imported_folder_to_check(path) else {
        return false;
    };

    validate_external_backup_dir(path, config_dir).is_ok()
        && Path::new(path)
            .join(super::EXTERNAL_BACKUP_FILE_NAME)
            .is_file()
}

/// Rejects a non-empty external backup directory that is not an existing directory, or that is
/// nested inside the app config directory. An empty value is the valid "off" state. The mirror is
/// only ever *written to* (an atomic export drops a `kavynex-backup.db` mirror into it), so it is
/// never read back through the asset scope or a delete/move command, but the whole point of the
/// mirror is to survive a failure of the config volume (where the database and every on-volume
/// `.bak` generation live), so it must not sit inside that directory either.
pub(crate) fn validate_external_backup_dir(
    external_backup_dir: &str,
    config_dir: Option<&Path>,
) -> AppResult<()> {
    let trimmed = external_backup_dir.trim();

    if trimmed.is_empty() {
        return Ok(());
    }

    if !std::fs::metadata(trimmed)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            "the external backup folder must be an existing directory",
        ));
    }

    // Refuse a mirror directory inside (or equal to) the app config directory. Pointing the
    // "off-volume" backup at the very directory it exists to outlive would silently defeat the
    // disaster-recovery intent. The daily mirror would write kavynex-backup.db next to the live
    // database, with no error or warning. Mirrors the containment check set_app_settings applies
    // to the library path, and the guard the manual export command already runs.
    if let Some(config_dir) = config_dir {
        if library_path_is_inside_dir(trimmed, config_dir) {
            return Err(AppError::from_code(
                AppErrorCode::InvalidInput,
                "the external backup folder cannot be inside the application data directory",
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-prepare-export-{tag}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
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
        // would not share that prefix, and the prefix is the whole point of this assertion.
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

    #[test]
    fn prepare_export_destination_returns_the_trimmed_path_outside_the_config_dir() {
        let config_dir = unique_dir("config");
        let outside_dir = unique_dir("outside");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&outside_dir).unwrap();

        let destination = outside_dir.join("backup.db");
        // Padded input. The returned path must be the *trimmed* destination. This pins the
        // single-path invariant (the guard and the write both act on exactly this path), so the
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
        // refused. It could clobber the live kavynex.db or one of its backup generations.
        let inside = config_dir.join("kavynex.db.bak");
        let error = prepare_export_destination(&inside.to_string_lossy(), &config_dir).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidTargetPath.as_str());

        let _ = std::fs::remove_dir_all(&config_dir);
    }

    #[test]
    fn prepare_export_destination_rejects_a_network_location() {
        // The export writes the whole database to this path, so a share here is both the NTLM leak
        // the import gate closes and an exfiltration of every row. Every spelling Windows resolves
        // to a share is covered, and each carries a valid `.db` extension so only the network check
        // can be what rejects it. The config dir is deliberately a path that does not exist. The
        // refusal has to come before `destination_is_inside_dir` canonicalizes anything.
        let config_dir = unique_dir("net");

        for value in [
            r"\\evil\share\library.db",
            "//evil/share/library.db",
            r"/\evil\share\library.db",
            r"\/evil\share\library.db",
            r"\\?\UNC\evil\share\library.db",
        ] {
            let error = prepare_export_destination(value, &config_dir)
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
    fn the_export_and_import_gates_refuse_the_same_network_spellings() {
        // The two directions already share DATABASE_FILE_EXTENSIONS, so this pins that they share
        // the network rule too. The import gate got it first and the export side went without for
        // a while, which is the asymmetry this asserts stays closed. The more so because the
        // extension parity test right below reads as though the two gates were already aligned.
        let config_dir = unique_dir("parity-net");

        for value in [
            r"\\host\share\db.db",
            "//host/share/db.sqlite",
            r"\\?\UNC\host\share\db.sqlite3",
        ] {
            assert!(
                prepare_export_destination(value, &config_dir).is_err(),
                "{value} should not be exportable"
            );
            assert!(
                prepare_import_source(value).is_err(),
                "{value} should not be importable"
            );
        }
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
            // Padded input. The returned path must be the *trimmed* source, so the guard and the
            // read act on one value. The same single-path invariant the export side pins.
            let padded = format!("   {}   ", source.to_string_lossy());

            let prepared = prepare_import_source(&padded)
                .unwrap_or_else(|error| panic!("{name} should be accepted: {error}"));
            assert_eq!(prepared, source);
        }
    }

    #[test]
    fn an_imported_folder_is_taken_only_when_it_already_looks_like_what_it_claims() {
        let dir = std::env::temp_dir().join(format!(
            "kavynex-imported-folders-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        let library = dir.join("Library");
        let mirror = dir.join("Mirror");
        std::fs::create_dir_all(&library).unwrap();
        std::fs::create_dir_all(&mirror).unwrap();
        let library_text = library.to_string_lossy().to_string();
        let mirror_text = mirror.to_string_lossy().to_string();

        // Existing folders that pass the settings checks, but nothing says Kavynex ever used them.
        assert!(!imported_library_is_usable(&library_text, None));
        assert!(!imported_mirror_is_usable(&mirror_text, None));

        std::fs::create_dir_all(library.join(crate::constants::LIBRARY_DIR_VIDEO)).unwrap();
        std::fs::write(
            mirror.join(super::super::EXTERNAL_BACKUP_FILE_NAME),
            b"mirror",
        )
        .unwrap();

        assert!(imported_library_is_usable(&library_text, None));
        assert!(imported_mirror_is_usable(&mirror_text, None));

        // Still refused when the folder is one the settings checks reject.
        assert!(!imported_library_is_usable(&library_text, Some(&dir)));
        assert!(!imported_mirror_is_usable(&mirror_text, Some(&dir)));
        assert!(!imported_library_is_usable("   ", None));
        assert!(!imported_mirror_is_usable("", None));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_imported_network_folder_is_refused_before_anything_resolves_it() {
        assert_eq!(
            imported_folder_to_check("  D:/Library  "),
            Some("D:/Library")
        );
        assert_eq!(imported_folder_to_check("   "), None);

        for path in [r"\\192.0.2.1\share\Library", "//192.0.2.1/share/Library"] {
            assert_eq!(imported_folder_to_check(path), None);
        }
    }

    #[test]
    fn an_import_keeps_this_machines_setting_whenever_it_has_one() {
        assert_eq!(
            machine_setting_after_import("C:\\Here", "D:\\There", true),
            "C:\\Here"
        );
        assert_eq!(
            machine_setting_after_import("  C:\\Here  ", "D:\\There", false),
            "C:\\Here"
        );
    }

    #[test]
    fn an_unconfigured_setting_takes_the_imported_value_only_when_it_is_valid_here() {
        // A fresh install restoring its own export keeps a library folder that exists here.
        assert_eq!(
            machine_setting_after_import("", "D:\\Library", true),
            "D:\\Library"
        );
        // A path from another machine that fails the settings check is left unconfigured, which
        // sends the user to choose the folder rather than trusting a value nothing validated.
        assert_eq!(
            machine_setting_after_import("   ", "D:\\Library", false),
            ""
        );
        assert_eq!(machine_setting_after_import("", "", true), "");
    }

    #[test]
    fn prepare_import_source_rejects_a_network_location() {
        // stage_database_import stats and opens this path. On Windows a UNC share authenticates
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
        // gate lives on the command rather than inside stage_database_import. Putting it there
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
        // side. The import gate is the newer of the two and the likelier one to be edited alone.
        for extension in DATABASE_FILE_EXTENSIONS {
            let candidate = unique_dir("parity").join(format!("db.{extension}"));
            let candidate = candidate.to_string_lossy().to_string();

            validate_export_destination(&candidate)
                .unwrap_or_else(|error| panic!(".{extension} should export: {error}"));
            prepare_import_source(&candidate)
                .unwrap_or_else(|error| panic!(".{extension} should import: {error}"));
        }
    }

    fn unique_test_dir(suffix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-settings-cmd-test-{suffix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn validate_external_backup_dir_accepts_empty_as_off() {
        validate_external_backup_dir("", None).unwrap();
        validate_external_backup_dir("   ", None).unwrap();
    }

    #[test]
    fn validate_external_backup_dir_accepts_an_existing_directory() {
        let dir = unique_test_dir("ext-existing");
        fs::create_dir_all(&dir).unwrap();

        validate_external_backup_dir(&dir.to_string_lossy(), None).unwrap();

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_external_backup_dir_rejects_a_missing_directory() {
        let missing = unique_test_dir("ext-missing");
        let error = validate_external_backup_dir(&missing.to_string_lossy(), None).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());
    }

    #[test]
    fn validate_external_backup_dir_rejects_a_directory_inside_the_config_dir() {
        // The external mirror exists to survive a failure of the config volume, so a directory
        // nested in the app config directory (where the database and its backups live) must be
        // refused. Otherwise the "off-volume" backup would silently sit on the same volume.
        let config_dir = unique_test_dir("ext-config");
        let inside = config_dir.join("backups");
        fs::create_dir_all(&inside).unwrap();

        let error =
            validate_external_backup_dir(&inside.to_string_lossy(), Some(&config_dir)).unwrap_err();
        assert_eq!(error.code, AppErrorCode::InvalidInput.as_str());

        let _ = fs::remove_dir_all(&config_dir);
    }

    #[test]
    fn validate_external_backup_dir_accepts_a_directory_outside_the_config_dir() {
        let config_dir = unique_test_dir("ext-config-sibling");
        let outside = unique_test_dir("ext-outside");
        fs::create_dir_all(&config_dir).unwrap();
        fs::create_dir_all(&outside).unwrap();

        validate_external_backup_dir(&outside.to_string_lossy(), Some(&config_dir)).unwrap();

        let _ = fs::remove_dir_all(&config_dir);
        let _ = fs::remove_dir_all(&outside);
    }
}
