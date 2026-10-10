use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::constants::MANAGED_LIBRARY_DIRS;
use crate::services::library::cleanup::LIBRARY_TRASH_DIR;

/// The folders a migration carries to the new library: the four the app writes media into, and the
/// trash the orphan removal moves files to. The trash has to travel too. Left behind, its files sat
/// outside the library they could be restored into, nothing purged them any more, and the old
/// folder stopped being a destination a later move back would accept.
const MIGRATED_LIBRARY_DIRS: [&str; 5] = [
    MANAGED_LIBRARY_DIRS[0],
    MANAGED_LIBRARY_DIRS[1],
    MANAGED_LIBRARY_DIRS[2],
    MANAGED_LIBRARY_DIRS[3],
    LIBRARY_TRASH_DIR,
];
use crate::services::filesystem::copy_directory_contents_tracked;
use crate::services::library::paths::ensure_library_dir;
use crate::services::logger;
use crate::{AppError, AppErrorCode, AppResult};

#[derive(Serialize, Clone, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct MigrateLibraryDirectoryResult {
    pub final_library_path: String,
    pub changed: bool,
    /// True when the migration copied the library to the new location but kept the old directory
    /// in place instead of removing it, which happens only when the crash-recovery commit marker
    /// could not be written (removing the old copy would then leave no recoverable path back). The
    /// copy succeeded and the new library is usable, but a full duplicate of the media remains on
    /// the old volume with nothing to clean it up automatically, so the frontend surfaces a notice.
    pub old_directory_retained: bool,
}

/// How far the copy phase has got, sent to the frontend while a migration runs.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct LibraryMigrationProgress {
    #[ts(type = "number")]
    pub copied_files: u64,
    #[ts(type = "number")]
    pub total_files: u64,
    #[ts(type = "number")]
    pub copied_bytes: u64,
    #[ts(type = "number")]
    pub total_bytes: u64,
}

/// The least time between two progress reports. A library of thumbnails copies thousands of small
/// files a second, and one IPC message each would cost more than the copy.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

static MIGRATION_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Asks the running migration to stop copying. Only the copy phase listens, since it is the long
/// one and the only one that leaves the old library untouched when stopped. A no-op when nothing
/// runs. The next migration clears the flag when it starts.
pub fn request_migration_cancel() {
    MIGRATION_CANCELLED.store(true, Ordering::SeqCst);
}

fn library_migration_lock() -> &'static Mutex<()> {
    static LIBRARY_MIGRATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LIBRARY_MIGRATION_LOCK.get_or_init(|| Mutex::new(()))
}

/// True for a file the OS itself drops into any folder the user merely browsed to in
/// Finder/Explorer (macOS `.DS_Store`, Windows `Thumbs.db`/`desktop.ini`). The user never put
/// these there, so a destination holding only them is still effectively empty and must not be
/// rejected as "not empty". Matched case-insensitively, since Windows filenames are.
fn is_ignorable_os_entry(name: &str) -> bool {
    const IGNORABLE_OS_FILES: [&str; 3] = [".ds_store", "thumbs.db", "desktop.ini"];

    let normalized = name.trim().to_ascii_lowercase();
    IGNORABLE_OS_FILES.contains(&normalized.as_str())
}

/// Refuses a destination that is the current library, or sits inside it or above it, under another
/// name.
///
/// The canonical paths cannot tell. On Windows `canonicalize` keeps the host as it was spelled, so
/// `\\nas\share\lib`, `\\192.168.0.10\share\lib` and a drive letter mapped to the same share come
/// back as three different strings for one folder. A library that holds only its managed folders is
/// exactly what a resumable destination looks like, so the copy would then skip every file as
/// already present and the removal of the old folder would delete the new one with it.
///
/// Two checks, because each covers what the other cannot. The directories' identity on disk
/// (volume and file index, or device and inode) is compared along both ancestor chains, which also
/// catches one folder inside the other. A file written into the new folder and looked for in the
/// old one covers a share whose server reports no usable file index.
fn ensure_distinct_directories(old: &Path, new: &Path) -> AppResult<()> {
    let same_folder = || {
        AppError::from_code(
            AppErrorCode::LibraryMigrationSameFolder,
            "the new library folder is the current one, or inside or above it, under another name",
        )
    };

    if directory_chain_contains(new, old) || directory_chain_contains(old, new) {
        return Err(same_folder());
    }

    let probe_name = format!(
        ".kavynex-migration-probe-{}",
        crate::utils::naming::unique_temp_suffix()
    );
    let probe = new.join(&probe_name);

    fs::write(&probe, b"").map_err(|e| {
        AppError::fs_error(
            AppErrorCode::InvalidLibraryMigration,
            "failed to write to the new library folder",
            new,
            &e,
        )
    })?;

    let seen_from_old = old.join(&probe_name).exists();
    let _ = fs::remove_file(&probe);

    if seen_from_old {
        return Err(same_folder());
    }

    Ok(())
}

/// Whether `path` or one of its ancestors is the directory `target`, compared by identity on disk.
///
/// A directory that cannot be opened counts as not matching. The probe file in
/// `ensure_distinct_directories` still covers the case that matters most, the two being one folder.
fn directory_chain_contains(path: &Path, target: &Path) -> bool {
    let Ok(target) = same_file::Handle::from_path(target) else {
        return false;
    };

    path.ancestors()
        .filter_map(|ancestor| same_file::Handle::from_path(ancestor).ok())
        .any(|ancestor| ancestor == target)
}

/// The destination must be empty, or contain only the app's managed subdirectories
/// (video/audio/thumbnails/live_chat) and nothing else. Empty is the normal case; a destination
/// that holds only managed folders is treated as a previously interrupted migration and allowed
/// to resume. The copy phase is idempotent (identical files are skipped, differing ones error
/// without overwriting), so re-running safely completes the copy. Any top-level entry that is
/// not a managed directory means the folder holds unrelated user content and is rejected, so a
/// crash mid-migration no longer wedges the retry with an opaque "not empty" error.
fn ensure_destination_is_migratable(path: &Path) -> AppResult<()> {
    let entries = fs::read_dir(path).map_err(|e| {
        AppError::from_code(
            AppErrorCode::InvalidLibraryMigration,
            format!("failed to inspect destination library directory: {e}"),
        )
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| {
            AppError::from_code(
                AppErrorCode::InvalidLibraryMigration,
                format!("failed to inspect destination library directory: {e}"),
            )
        })?;

        let name = entry.file_name().to_string_lossy().to_string();
        let is_managed_name = MIGRATED_LIBRARY_DIRS.contains(&name.as_str());

        // A migration never creates a link, so a managed folder that is one points somewhere else,
        // possibly at the current library's own folder. Copying into it would copy each file onto
        // itself, and the removal that follows would delete the only copy.
        if is_managed_name && crate::services::filesystem::dir_entry_is_symlink(&entry) {
            return Err(AppError::from_code(
                AppErrorCode::LibraryMigrationSameFolder,
                "a managed folder in the destination is a link to another folder",
            ));
        }

        let is_managed_dir = is_managed_name && entry.path().is_dir();

        // A managed subdirectory (a previous, interrupted migration to resume) and an OS-generated
        // file (which the user did not put there) are both allowed; anything else is unrelated user
        // content and rejected, so a real non-empty folder is never migrated into.
        if !is_managed_dir && !is_ignorable_os_entry(&name) {
            return Err(AppError::from_code(
                AppErrorCode::InvalidLibraryMigration,
                "the selected library folder must be empty (or contain only a previous, interrupted Kavynex migration); choose an empty folder to continue",
            ));
        }
    }

    Ok(())
}

pub fn migrate_library_contents(old_library_dir: &Path, new_library_dir: &Path) -> AppResult<()> {
    copy_library_contents(old_library_dir, new_library_dir, None, &mut |_| {})?;
    remove_old_library_contents(old_library_dir);
    Ok(())
}

/// Calls `visit` with the path relative to `root` and the size of every regular file in `root`'s
/// managed directories. Symlinks are skipped, as `copy_directory_contents` skips them, so the walk
/// sees exactly the files the copy writes.
fn for_each_managed_file(
    root: &Path,
    visit: &mut impl FnMut(&Path, u64) -> AppResult<()>,
) -> AppResult<()> {
    fn walk(
        dir: &Path,
        relative: &Path,
        visit: &mut impl FnMut(&Path, u64) -> AppResult<()>,
    ) -> AppResult<()> {
        let entries = fs::read_dir(dir).map_err(|e| {
            AppError::fs_error(
                AppErrorCode::ReadDirFailed,
                "failed to read directory",
                dir,
                &e,
            )
        })?;

        for entry in entries {
            let entry = entry.map_err(|e| {
                AppError::fs_error(
                    AppErrorCode::ReadDirEntryFailed,
                    "failed to read directory entry",
                    dir,
                    &e,
                )
            })?;

            let path = entry.path();

            // Refused rather than skipped. The copy and the completeness check would both pass it
            // over, the old folder's removal would take the link, and every row naming the file
            // would read as missing in the new library. The app never makes links of its own, so
            // this is one the user put there, and only they can say what it should become.
            if crate::services::filesystem::dir_entry_is_symlink(&entry) {
                return Err(AppError::with_details(
                    AppErrorCode::InvalidSourceFile,
                    "the library holds a link to a file elsewhere, which a move cannot carry; replace it with the file itself and try again",
                    format!("path: {}", logger::redact_path(&path)),
                ));
            }

            let child = relative.join(entry.file_name());

            // An entry this walk cannot classify or size is an error rather than a skip. The copy
            // refuses the same entries, and a file left out of both would pass the completeness
            // check and then be removed with the old folder.
            let file_type = entry.file_type().map_err(|e| {
                AppError::fs_error(
                    AppErrorCode::ReadDirEntryFailed,
                    "failed to read the type of a directory entry",
                    &path,
                    &e,
                )
            })?;

            if file_type.is_dir() {
                walk(&path, &child, visit)?;
                continue;
            }

            if !file_type.is_file() {
                return Err(AppError::with_details(
                    AppErrorCode::InvalidSourceFile,
                    "found an entry that is neither a file nor a folder",
                    format!("path: {}", logger::redact_path(&path)),
                ));
            }

            let metadata = path.metadata().map_err(|e| {
                AppError::fs_error(
                    AppErrorCode::SourceMetadataFailed,
                    "failed to read the size of a library file",
                    &path,
                    &e,
                )
            })?;

            visit(&child, metadata.len())?;
        }

        Ok(())
    }

    for dir_name in MIGRATED_LIBRARY_DIRS {
        let dir = root.join(dir_name);

        if dir.is_dir() {
            walk(&dir, Path::new(dir_name), visit)?;
        }
    }

    Ok(())
}

/// The size of `relative` under `root`, or `None` when it is not a file there.
fn file_size_at(root: &Path, relative: &Path) -> Option<u64> {
    root.join(relative)
        .metadata()
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|metadata| metadata.len())
}

/// What the copy still has to write. Every file of the old library whose counterpart in the new
/// one is missing or a different size, so a resumed migration is not asked for room it has
/// already used.
fn bytes_left_to_copy(old_library_dir: &Path, new_library_dir: &Path) -> AppResult<u64> {
    let mut needed: u64 = 0;

    for_each_managed_file(old_library_dir, &mut |relative, size| {
        if file_size_at(new_library_dir, relative) != Some(size) {
            needed = needed.saturating_add(size);
        }
        Ok(())
    })?;

    Ok(needed)
}

/// Whether `available` bytes fit `needed`. An unknown free space lets the migration go ahead, as
/// it did before this check existed, and the copy fails on its own when the disk fills.
fn has_room_for(needed: u64, available: Option<u64>) -> bool {
    available.is_none_or(|available| available >= needed)
}

/// The bytes the current user can still write on the volume holding `path`, or `None` when the
/// platform call fails.
#[cfg(windows)]
fn available_space_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(
            lp_directory_name: *const u16,
            lp_free_bytes_available_to_caller: *mut u64,
            lp_total_number_of_bytes: *mut u64,
            lp_total_number_of_free_bytes: *mut u64,
        ) -> i32;
    }

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available: u64 = 0;

    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call, `available` is a
    // valid u64 to write to, and the two totals are optional and passed as null.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };

    (ok != 0).then_some(available)
}

/// Unix counterpart, through `statvfs`. `f_bavail` is the count available to an unprivileged
/// process, which is what the copy runs as.
#[cfg(unix)]
fn available_space_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();

    // SAFETY: `c_path` is NUL-terminated and outlives the call, and `stat` is only read after the
    // call reported success, which means it was filled in.
    let result = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };

    if result != 0 {
        return None;
    }

    // SAFETY: statvfs returned 0, so it initialized `stat`.
    let stat = unsafe { stat.assume_init() };

    #[allow(clippy::unnecessary_cast)]
    Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

/// Refuses a migration whose destination volume cannot hold what is left to copy. Checked before
/// anything is written, because running out of space halfway leaves a partial copy on the new
/// drive and nothing gained.
fn ensure_room_for_migration(old_library_dir: &Path, new_library_dir: &Path) -> AppResult<()> {
    let needed = bytes_left_to_copy(old_library_dir, new_library_dir)?;
    let available = available_space_bytes(new_library_dir);

    if has_room_for(needed, available) {
        return Ok(());
    }

    Err(AppError::from_code_with_details(
        AppErrorCode::NotEnoughSpaceForLibrary,
        "the new library folder's drive does not have enough free space",
        format!(
            "{} to copy, {} available",
            crate::utils::format::format_bytes(needed),
            crate::utils::format::format_bytes(available.unwrap_or(0))
        ),
    ))
}

/// The first file of the old library that has no copy of the same size in the new one.
///
/// Run after the copy and before anything of the old library is removed. The copy reports
/// success file by file, and this is the last point where the old folder still holds everything,
/// so a file that did not arrive whole (a destination that filled up or went away mid-copy, a
/// file that changed while it was read) stops the migration here instead of being deleted.
fn first_incomplete_copy(
    old_library_dir: &Path,
    new_library_dir: &Path,
) -> AppResult<Option<PathBuf>> {
    let mut incomplete: Option<PathBuf> = None;

    for_each_managed_file(old_library_dir, &mut |relative, size| {
        if incomplete.is_none() && file_size_at(new_library_dir, relative) != Some(size) {
            incomplete = Some(relative.to_path_buf());
        }
        Ok(())
    })?;

    Ok(incomplete)
}

/// Phase 1. Copy all managed directories to the new location without touching the originals.
/// If any copy fails here, the old library is still fully intact and the app continues working
/// normally against the old path.
///
/// `report` gets the progress at the start, then at most every [`PROGRESS_INTERVAL`], and once
/// more when the last file is in. A set `cancel` stops the copy with `LibraryMigrationCancelled`.
/// What was copied so far stays in the new folder, which a later attempt resumes from.
fn copy_library_contents(
    old_library_dir: &Path,
    new_library_dir: &Path,
    cancel: Option<&AtomicBool>,
    report: &mut dyn FnMut(LibraryMigrationProgress),
) -> AppResult<()> {
    let mut progress = LibraryMigrationProgress::default();

    for_each_managed_file(old_library_dir, &mut |_, size| {
        progress.total_files += 1;
        progress.total_bytes = progress.total_bytes.saturating_add(size);
        Ok(())
    })?;

    report(progress);

    let result = copy_library_contents_reporting(
        old_library_dir,
        new_library_dir,
        cancel,
        &mut progress,
        report,
    );

    match result {
        Err(_) if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) => {
            Err(AppError::from_code(
                AppErrorCode::LibraryMigrationCancelled,
                "the library move was cancelled before the old folder was touched",
            ))
        }
        other => other,
    }
}

fn copy_library_contents_reporting(
    old_library_dir: &Path,
    new_library_dir: &Path,
    cancel: Option<&AtomicBool>,
    progress: &mut LibraryMigrationProgress,
    report: &mut dyn FnMut(LibraryMigrationProgress),
) -> AppResult<()> {
    let mut last_report = Instant::now();

    fs::create_dir_all(new_library_dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateNewLibraryDirFailed,
            format!("failed to create new library directory: {e}"),
        )
    })?;

    for dir_name in MIGRATED_LIBRARY_DIRS {
        let source_dir = old_library_dir.join(dir_name);
        let destination_dir = new_library_dir.join(dir_name);

        logger::info(
            "library",
            format!(
                "copying managed directory '{}' from '{}' to '{}'",
                dir_name,
                logger::redact_path(&source_dir),
                logger::redact_path(&destination_dir)
            ),
        );

        copy_directory_contents_tracked(&source_dir, &destination_dir, cancel, &mut |size| {
            progress.copied_files += 1;
            progress.copied_bytes = progress.copied_bytes.saturating_add(size);

            if progress.copied_files == progress.total_files
                || last_report.elapsed() >= PROGRESS_INTERVAL
            {
                report(*progress);
                last_report = Instant::now();
            }
        })?;
    }

    Ok(())
}

/// Phase 2. All copies confirmed. Remove the old managed directories, then the old library
/// directory itself if nothing unrelated is left in it. Best effort. A removal failure only
/// leaves reclaimable disk behind, never lost data (the new location already holds a full copy).
fn remove_old_library_contents(old_library_dir: &Path) {
    for dir_name in MIGRATED_LIBRARY_DIRS {
        let source_dir = old_library_dir.join(dir_name);

        if source_dir.exists() {
            // A partial failure here (a locked file, an AV scanner, a permission hiccup) leaves
            // the managed directory behind holding an unknown subset of its files. That is only
            // reclaimable disk (the new location already holds a full copy), but it must be
            // logged rather than swallowed. The recovery path keys off the marker target being a
            // complete copy, not off the old directory looking empty, precisely so a leftover
            // like this cannot strand the good copy.
            if let Err(error) = fs::remove_dir_all(&source_dir) {
                logger::warn(
                    "library",
                    format!(
                        "failed to remove old managed directory '{}' after migration (reclaimable disk left behind): {error}",
                        logger::redact_path(&source_dir)
                    ),
                );
            }
        }
    }

    let leftovers = list_leftover_entries(old_library_dir);

    if !leftovers.is_empty() {
        let examples = leftovers
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");

        logger::warn(
            "library",
            format!(
                "library migration left {} entr{} behind in the old library directory '{}' that were not part of the managed folders: {}",
                leftovers.len(),
                if leftovers.len() == 1 { "y" } else { "ies" },
                logger::redact_path(old_library_dir),
                examples
            ),
        );
    }

    let _ = fs::remove_dir(old_library_dir);
}

/// Runs the copy/remove phases with a durable commit marker written between them, so an
/// interrupted migration (a crash after the copy but before the frontend persists the new
/// library path) can be recovered on the next launch. When `commit_marker` is `Some` and the
/// marker cannot be written, the old directory is deliberately left intact. Reclaiming its disk
/// is not worth removing the only path back to the library when recovery would be impossible.
/// `None` (used by tests) keeps the plain copy-then-remove behavior.
///
/// Returns `true` when the old directory was deliberately kept (the marker could not be written),
/// `false` when it was removed as usual, so the caller can surface the retained-copy state.
fn migrate_library_contents_with_marker(
    old_library_dir: &Path,
    new_library_dir: &Path,
    commit_marker: Option<&Path>,
    report: &mut dyn FnMut(LibraryMigrationProgress),
) -> AppResult<bool> {
    copy_library_contents(
        old_library_dir,
        new_library_dir,
        Some(&MIGRATION_CANCELLED),
        report,
    )?;

    if let Some(relative) = first_incomplete_copy(old_library_dir, new_library_dir)? {
        return Err(AppError::from_code_with_details(
            AppErrorCode::LibraryCopyIncomplete,
            "a library file was not copied completely, so the old library folder was kept as it was",
            relative.to_string_lossy().to_string(),
        ));
    }

    if let Some(marker) = commit_marker {
        if let Err(error) = crate::services::library::recovery::write_commit_marker(
            marker,
            &new_library_dir.to_string_lossy(),
        ) {
            logger::warn(
                "library",
                format!(
                    "keeping the old library directory: failed to write the migration commit marker: {error}"
                ),
            );
            return Ok(true);
        }
    }

    remove_old_library_contents(old_library_dir);
    Ok(false)
}

/// Lists the top-level entries of `old_library_dir` that are not one of the managed library
/// folders (video/audio/thumbnails/live_chat). The library folder is normally fully owned by
/// the app, but a user can still drop files directly into it; those are never migrated, so
/// they would otherwise be silently left behind (and keep the old directory from being
/// removed) without any indication of why.
fn list_leftover_entries(old_library_dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(old_library_dir) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();

            if MIGRATED_LIBRARY_DIRS.contains(&name.as_str()) {
                None
            } else {
                Some(name)
            }
        })
        .collect()
}

/// What the caller knows that the filesystem cannot tell the migration.
#[derive(Debug, Clone, Copy, Default)]
pub struct MigrationContext {
    /// The database lists media (or channel avatars) that live in the current library.
    pub library_has_media: bool,
    /// The user confirmed switching to the new folder although the current one cannot be reached,
    /// knowing nothing will be moved.
    pub switch_without_moving: bool,
}

/// Whether a migration whose current library folder does not exist has to stop and ask.
///
/// It used to switch without a word, which was right for a library that was never used and wrong
/// for one whose drive is simply not connected. Every media then pointed at the new, empty folder
/// and read as missing.
fn must_ask_before_switching(context: MigrationContext) -> bool {
    context.library_has_media && !context.switch_without_moving
}

pub fn migrate_library_directory_sync(
    old_library_path: &str,
    new_library_path: &str,
    commit_marker: Option<&Path>,
) -> AppResult<MigrateLibraryDirectoryResult> {
    migrate_library_directory_in_context(
        old_library_path,
        new_library_path,
        commit_marker,
        MigrationContext::default(),
        &mut |_| {},
    )
}

/// The migration, with what the caller knows (`context`) and a `report` for the copy's progress
/// (see `copy_library_contents`).
pub fn migrate_library_directory_in_context(
    old_library_path: &str,
    new_library_path: &str,
    commit_marker: Option<&Path>,
    context: MigrationContext,
    report: &mut dyn FnMut(LibraryMigrationProgress),
) -> AppResult<MigrateLibraryDirectoryResult> {
    let migration_guard = match library_migration_lock().try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::WouldBlock) => {
            return Err(AppError::from_code(
                AppErrorCode::LibraryMigrationAlreadyRunning,
                "a library migration is already running",
            ));
        }
        // A previous migration panicked while holding this lock. The mutex guards no shared
        // state (`Mutex<()>`; it only serializes migrations), so the poison carries no
        // corrupted data. Recover the guard and proceed. Treating poison as "already
        // running" would instead wedge every future migration until the app is restarted.
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
    };

    // Cleared once the lock is held, so a cancel left over from an earlier run cannot stop this one.
    MIGRATION_CANCELLED.store(false, Ordering::SeqCst);

    let canonical_new = ensure_library_dir(new_library_path)?;
    let old_library_dir = PathBuf::from(old_library_path.trim());

    logger::info(
        "library",
        format!(
            "requested library migration from '{}' to '{}'",
            logger::redact_path(old_library_path.trim()),
            logger::redact_path(&canonical_new)
        ),
    );

    if old_library_dir.as_os_str().is_empty() {
        ensure_destination_is_migratable(&canonical_new)?;

        drop(migration_guard);
        return Ok(MigrateLibraryDirectoryResult {
            final_library_path: canonical_new.to_string_lossy().to_string(),
            changed: true,
            old_directory_retained: false,
        });
    }

    if !old_library_dir.exists() {
        if must_ask_before_switching(context) {
            drop(migration_guard);
            return Err(AppError::from_code(
                AppErrorCode::LibraryFolderUnreachable,
                "the current library folder cannot be reached and the library still lists media in it",
            ));
        }

        ensure_destination_is_migratable(&canonical_new)?;

        drop(migration_guard);
        return Ok(MigrateLibraryDirectoryResult {
            final_library_path: canonical_new.to_string_lossy().to_string(),
            changed: true,
            old_directory_retained: false,
        });
    }

    let canonical_old = old_library_dir.canonicalize().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CanonicalizeLibraryPathFailed,
            format!("failed to canonicalize current library path: {e}"),
        )
    })?;

    if canonical_old == canonical_new {
        logger::info(
            "library",
            format!(
                "library migration skipped because paths are identical: '{}'",
                logger::redact_path(&canonical_new)
            ),
        );
        drop(migration_guard);
        return Ok(MigrateLibraryDirectoryResult {
            final_library_path: canonical_new.to_string_lossy().to_string(),
            changed: false,
            old_directory_retained: false,
        });
    }

    if canonical_new.starts_with(&canonical_old) {
        drop(migration_guard);
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryMigration,
            "new library path cannot be inside the current library path",
        ));
    }

    if canonical_old.starts_with(&canonical_new) {
        drop(migration_guard);
        return Err(AppError::from_code(
            AppErrorCode::InvalidLibraryMigration,
            "new library path cannot be a parent directory of the current library path",
        ));
    }

    ensure_distinct_directories(&canonical_old, &canonical_new)?;
    ensure_destination_is_migratable(&canonical_new)?;
    ensure_room_for_migration(&canonical_old, &canonical_new)?;

    // Hold the exclusive library gate across the copy/remove phase. It drains any in-flight
    // import/download/delete and blocks new ones, so a file can never be written into the old
    // directory in the window between it being copied to the new location and removed. Only the
    // destructive phase needs it; the validation above is read-only. See services/library/lock.
    let migration_result = {
        let _library_write_guard = crate::services::library::lock::library_write_guard();
        migrate_library_contents_with_marker(&canonical_old, &canonical_new, commit_marker, report)
    };

    match &migration_result {
        Ok(retained) => logger::info(
            "library",
            format!(
                "library migration finished successfully from '{}' to '{}'{}",
                logger::redact_path(&canonical_old),
                logger::redact_path(&canonical_new),
                if *retained {
                    " (the old directory was kept because the commit marker could not be written)"
                } else {
                    ""
                }
            ),
        ),
        Err(error) => logger::error(
            "library",
            format!(
                "library migration failed from '{}' to '{}': {}",
                logger::redact_path(&canonical_old),
                logger::redact_path(&canonical_new),
                error
            ),
        ),
    }

    drop(migration_guard);

    let old_directory_retained = migration_result?;

    Ok(MigrateLibraryDirectoryResult {
        final_library_path: canonical_new.to_string_lossy().to_string(),
        changed: true,
        old_directory_retained,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn migration_test_lock() -> &'static Mutex<()> {
        static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        TEST_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-library-migration-test-{prefix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    #[test]
    fn migrate_library_contents_moves_managed_directories() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("old");
        let new_root = unique_test_dir("new");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(old_root.join("audio")).unwrap();
        fs::create_dir_all(old_root.join("thumbnails")).unwrap();

        fs::write(old_root.join("video").join("a.mp4"), b"video").unwrap();
        fs::write(old_root.join("audio").join("a.mp3"), b"audio").unwrap();
        fs::write(old_root.join("thumbnails").join("a.jpg"), b"thumb").unwrap();

        migrate_library_contents(&old_root, &new_root).unwrap();

        assert!(new_root.join("video").join("a.mp4").exists());
        assert!(new_root.join("audio").join("a.mp3").exists());
        assert!(new_root.join("thumbnails").join("a.jpg").exists());

        let _ = fs::remove_dir_all(new_root);
        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn the_room_check_counts_only_what_is_left_to_copy() {
        let old_root = unique_test_dir("room-old");
        let new_root = unique_test_dir("room-new");
        fs::create_dir_all(old_root.join("video").join("nested")).unwrap();
        fs::create_dir_all(old_root.join("thumbnails")).unwrap();
        fs::create_dir_all(new_root.join("video")).unwrap();

        fs::write(old_root.join("video").join("done.mp4"), b"12345").unwrap();
        fs::write(
            old_root.join("video").join("nested").join("todo.mp4"),
            b"1234567",
        )
        .unwrap();
        fs::write(old_root.join("thumbnails").join("half.jpg"), b"abc").unwrap();
        // A file outside the managed folders is never copied, so it needs no room.
        fs::write(old_root.join("stray.txt"), b"ignored by the copy").unwrap();

        // A resumed migration. One file already arrived whole, another only partly.
        fs::write(new_root.join("video").join("done.mp4"), b"12345").unwrap();
        fs::create_dir_all(new_root.join("thumbnails")).unwrap();
        fs::write(new_root.join("thumbnails").join("half.jpg"), b"a").unwrap();

        assert_eq!(bytes_left_to_copy(&old_root, &new_root).unwrap(), 7 + 3);

        let _ = fs::remove_dir_all(new_root);
        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn the_copy_reports_its_totals_first_and_everything_copied_last() {
        let old_root = unique_test_dir("progress-old");
        let new_root = unique_test_dir("progress-new");
        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(old_root.join("thumbnails")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"12345").unwrap();
        fs::write(old_root.join("video").join("b.mp4"), b"123").unwrap();
        fs::write(old_root.join("thumbnails").join("a.jpg"), b"12").unwrap();

        let mut reports = Vec::new();
        copy_library_contents(&old_root, &new_root, None, &mut |progress| {
            reports.push(progress)
        })
        .unwrap();

        assert_eq!(
            reports.first(),
            Some(&LibraryMigrationProgress {
                copied_files: 0,
                total_files: 3,
                copied_bytes: 0,
                total_bytes: 10,
            })
        );
        assert_eq!(
            reports.last(),
            Some(&LibraryMigrationProgress {
                copied_files: 3,
                total_files: 3,
                copied_bytes: 10,
                total_bytes: 10,
            })
        );

        let _ = fs::remove_dir_all(new_root);
        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn a_cancelled_copy_stops_with_its_own_code_and_leaves_the_old_library_whole() {
        let old_root = unique_test_dir("cancel-old");
        let new_root = unique_test_dir("cancel-new");
        fs::create_dir_all(old_root.join("audio")).unwrap();
        fs::write(old_root.join("audio").join("a.mp3"), b"audio").unwrap();

        let cancel = AtomicBool::new(true);
        let error =
            copy_library_contents(&old_root, &new_root, Some(&cancel), &mut |_| {}).unwrap_err();

        assert_eq!(error.code, AppErrorCode::LibraryMigrationCancelled.as_str());
        assert!(old_root.join("audio").join("a.mp3").is_file());
        assert!(!new_root.join("audio").join("a.mp3").exists());

        // A copy that failed for another reason keeps its own error.
        let not_cancelled = AtomicBool::new(false);
        fs::create_dir_all(new_root.join("audio").join("a.mp3")).unwrap();
        let error = copy_library_contents(&old_root, &new_root, Some(&not_cancelled), &mut |_| {})
            .unwrap_err();
        assert_ne!(error.code, AppErrorCode::LibraryMigrationCancelled.as_str());

        let _ = fs::remove_dir_all(new_root);
        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn a_cancel_request_reaches_the_copy_and_the_next_migration_clears_it() {
        let _guard = migration_test_lock().lock().unwrap();

        request_migration_cancel();
        assert!(MIGRATION_CANCELLED.load(Ordering::SeqCst));

        // A first-time setup is the shortest migration that takes the lock.
        let new_root = unique_test_dir("cancel-cleared");
        fs::create_dir_all(&new_root).unwrap();
        migrate_library_directory_sync("   ", new_root.to_string_lossy().as_ref(), None).unwrap();

        assert!(!MIGRATION_CANCELLED.load(Ordering::SeqCst));

        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn a_destination_fits_when_its_free_space_covers_the_copy_or_is_unknown() {
        assert!(has_room_for(10, Some(10)));
        assert!(has_room_for(10, Some(11)));
        assert!(!has_room_for(10, Some(9)));
        assert!(has_room_for(10, None));
    }

    #[test]
    fn the_free_space_of_a_real_folder_can_be_read() {
        // Not asserted against a number, which depends on the machine. Only that the platform
        // call works on a path that exists, which the room check depends on.
        assert!(available_space_bytes(&std::env::temp_dir()).is_some());
    }

    #[test]
    fn a_copy_missing_a_file_or_holding_a_short_one_is_reported_before_anything_is_removed() {
        let old_root = unique_test_dir("incomplete-old");
        let new_root = unique_test_dir("incomplete-new");
        fs::create_dir_all(old_root.join("audio")).unwrap();
        fs::create_dir_all(new_root.join("audio")).unwrap();
        fs::write(old_root.join("audio").join("a.mp3"), b"whole").unwrap();
        fs::write(new_root.join("audio").join("a.mp3"), b"whole").unwrap();

        assert_eq!(first_incomplete_copy(&old_root, &new_root).unwrap(), None);

        fs::write(old_root.join("audio").join("b.mp3"), b"longer file").unwrap();
        fs::write(new_root.join("audio").join("b.mp3"), b"short").unwrap();

        assert_eq!(
            first_incomplete_copy(&old_root, &new_root).unwrap(),
            Some(Path::new("audio").join("b.mp3"))
        );

        fs::remove_file(new_root.join("audio").join("b.mp3")).unwrap();

        assert_eq!(
            first_incomplete_copy(&old_root, &new_root).unwrap(),
            Some(Path::new("audio").join("b.mp3"))
        );

        let _ = fs::remove_dir_all(new_root);
        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn a_missing_library_with_media_in_it_asks_before_switching() {
        let _guard = migration_test_lock().lock().unwrap();

        let missing_old = unique_test_dir("unreachable-old");
        let new_root = unique_test_dir("unreachable-new");
        fs::create_dir_all(&new_root).unwrap();

        let with_media = MigrationContext {
            library_has_media: true,
            switch_without_moving: false,
        };
        let error = migrate_library_directory_in_context(
            missing_old.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
            with_media,
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(error.code, AppErrorCode::LibraryFolderUnreachable.as_str());

        // Once the user confirmed, it switches without moving anything, as before.
        let confirmed = migrate_library_directory_in_context(
            missing_old.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
            MigrationContext {
                switch_without_moving: true,
                ..with_media
            },
            &mut |_| {},
        )
        .unwrap();
        assert!(confirmed.changed);

        // A library that never held anything switches without asking.
        assert!(
            migrate_library_directory_in_context(
                missing_old.to_string_lossy().as_ref(),
                new_root.to_string_lossy().as_ref(),
                None,
                MigrationContext::default(),
                &mut |_| {},
            )
            .unwrap()
            .changed
        );

        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn list_leftover_entries_finds_files_outside_managed_dirs() {
        let old_root = unique_test_dir("leftovers");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(old_root.join("thumbnails")).unwrap();
        fs::write(old_root.join("stray-file.txt"), b"leftover").unwrap();

        let leftovers = list_leftover_entries(&old_root);

        assert_eq!(leftovers, vec!["stray-file.txt".to_string()]);

        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn list_leftover_entries_is_empty_when_only_managed_dirs_are_present() {
        let old_root = unique_test_dir("no-leftovers");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(old_root.join("audio")).unwrap();
        fs::create_dir_all(old_root.join("thumbnails")).unwrap();
        fs::create_dir_all(old_root.join("live_chat")).unwrap();

        let leftovers = list_leftover_entries(&old_root);

        assert!(leftovers.is_empty());

        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn migrate_library_contents_keeps_old_dir_when_a_stray_file_is_left_behind() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("stray");
        let new_root = unique_test_dir("stray-new");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video").unwrap();
        // Not part of any managed directory. The migration never touches it, so it stays
        // behind and the old directory can no longer be removed.
        fs::write(old_root.join("notes.txt"), b"leftover notes").unwrap();

        migrate_library_contents(&old_root, &new_root).unwrap();

        assert!(new_root.join("video").join("a.mp4").exists());
        // The stray file (and therefore the old directory) is left in place, best-effort.
        assert!(old_root.join("notes.txt").exists());
        assert!(old_root.exists());

        let _ = fs::remove_dir_all(new_root);
        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn migrate_library_directory_sync_returns_new_path_when_old_is_empty() {
        let _guard = migration_test_lock().lock().unwrap();

        let new_root = unique_test_dir("empty-old");
        let result =
            migrate_library_directory_sync("   ", new_root.to_string_lossy().as_ref(), None)
                .unwrap();

        let canonical_new = new_root
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();

        assert_eq!(result.final_library_path, canonical_new);
        assert!(result.changed);

        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn migrate_library_directory_sync_returns_new_path_when_old_does_not_exist() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("missing-old");
        let new_root = unique_test_dir("missing-new");

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
        )
        .unwrap();

        let canonical_new = new_root
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();

        assert_eq!(result.final_library_path, canonical_new);
        assert!(result.changed);

        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn migrate_library_directory_sync_skips_when_paths_are_identical() {
        let _guard = migration_test_lock().lock().unwrap();

        let root = unique_test_dir("same");
        fs::create_dir_all(&root).unwrap();

        let result = migrate_library_directory_sync(
            root.to_string_lossy().as_ref(),
            root.to_string_lossy().as_ref(),
            None,
        )
        .unwrap();

        let canonical = root.canonicalize().unwrap().to_string_lossy().to_string();
        assert_eq!(result.final_library_path, canonical);
        assert!(!result.changed);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_library_directory_sync_rejects_child_destination() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("old-child");
        let new_root = old_root.join("nested").join("library");

        fs::create_dir_all(&old_root).unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
        );

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidLibraryMigration.as_str()
        );

        let _ = fs::remove_dir_all(old_root);
    }

    #[test]
    fn migrate_library_directory_sync_rejects_parent_destination() {
        let _guard = migration_test_lock().lock().unwrap();

        let parent_root = unique_test_dir("parent");
        let old_root = parent_root.join("current");

        fs::create_dir_all(&old_root).unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            parent_root.to_string_lossy().as_ref(),
            None,
        );

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidLibraryMigration.as_str()
        );

        let _ = fs::remove_dir_all(parent_root);
    }

    #[test]
    fn migrate_library_contents_preserves_source_when_copy_fails_mid_migration() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("preserve-old");
        let new_root = unique_test_dir("preserve-new");

        // video dir is processed first; audio dir second
        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(old_root.join("audio")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video-data").unwrap();
        fs::write(old_root.join("audio").join("a.mp3"), b"audio-data").unwrap();

        // Pre-create a conflicting audio file in the destination so the copy fails
        // after the video directory has already been processed
        fs::create_dir_all(new_root.join("audio")).unwrap();
        fs::write(new_root.join("audio").join("a.mp3"), b"conflicting-content").unwrap();

        let result = migrate_library_contents(&old_root, &new_root);
        assert!(result.is_err());

        // Both source files must still exist. No data was lost despite partial progress
        assert!(
            old_root.join("video").join("a.mp4").exists(),
            "video file must remain in source after failed migration"
        );
        assert!(
            old_root.join("audio").join("a.mp3").exists(),
            "audio file must remain in source after failed migration"
        );

        let _ = fs::remove_dir_all(&old_root);
        let _ = fs::remove_dir_all(&new_root);
    }

    #[test]
    fn migrate_library_directory_sync_resumes_an_interrupted_migration() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("resume-old");
        let new_root = unique_test_dir("resume-new");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video-data").unwrap();
        fs::write(old_root.join("video").join("b.mp4"), b"video-b").unwrap();

        // Simulate a prior migration interrupted mid-copy. The destination already holds the
        // managed "video" dir with one file (identical content) and nothing unrelated.
        fs::create_dir_all(new_root.join("video")).unwrap();
        fs::write(new_root.join("video").join("a.mp4"), b"video-data").unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
        )
        .unwrap();

        assert!(result.changed);
        // The remaining file is copied and the migration completes instead of failing with a
        // "not empty" error.
        assert!(new_root.join("video").join("a.mp4").exists());
        assert!(new_root.join("video").join("b.mp4").exists());

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn migrate_library_directory_sync_writes_the_commit_marker_when_it_removes_the_old_library() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("marker-old");
        let new_root = unique_test_dir("marker-new");
        let marker = unique_test_dir("marker-file");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video-data").unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            Some(&marker),
        )
        .unwrap();

        assert!(result.changed);
        // The marker was written, so phase 2 ran and the old directory was not retained.
        assert!(!result.old_directory_retained);
        assert!(new_root.join("video").join("a.mp4").exists());
        // The old managed directory is removed (phase 2 ran)...
        assert!(!old_root.join("video").exists());
        // ...and only because the durable commit marker recording the new path was written
        // first, so a crash before the frontend persisted the new path stays recoverable.
        let recorded = fs::read_to_string(&marker).unwrap();
        assert_eq!(recorded.trim(), result.final_library_path);

        let _ = fs::remove_dir_all(&old_root);
        let _ = fs::remove_dir_all(&new_root);
        let _ = fs::remove_file(&marker);
    }

    #[test]
    fn is_ignorable_os_entry_matches_only_os_generated_files() {
        for name in [
            ".DS_Store",
            ".ds_store",
            "Thumbs.db",
            "thumbs.db",
            "desktop.ini",
            " Desktop.ini ",
        ] {
            assert!(is_ignorable_os_entry(name), "{name} should be ignorable");
        }

        for name in [
            "video",
            "notes.txt",
            "my.DS_Store.mp4",
            "thumbs.db.bak",
            ".ds_storex",
        ] {
            assert!(
                !is_ignorable_os_entry(name),
                "{name} should not be ignorable"
            );
        }
    }

    #[test]
    fn ensure_destination_is_migratable_accepts_empty_managed_and_os_litter() {
        // The three shapes a destination is allowed to have. Empty, holding only the managed
        // subdirectories a previous interrupted migration left, and holding only OS-generated
        // files the user did not put there.
        let empty = unique_test_dir("dest-empty");
        fs::create_dir_all(&empty).unwrap();
        ensure_destination_is_migratable(&empty).unwrap();

        let managed = unique_test_dir("dest-managed");
        for name in MANAGED_LIBRARY_DIRS {
            fs::create_dir_all(managed.join(name)).unwrap();
        }
        fs::write(managed.join(".DS_Store"), b"").unwrap();
        ensure_destination_is_migratable(&managed).unwrap();

        let _ = fs::remove_dir_all(&empty);
        let _ = fs::remove_dir_all(&managed);
    }

    #[test]
    fn ensure_destination_is_migratable_rejects_a_directory_that_is_not_a_managed_one() {
        // The guard is `is_dir() && MANAGED_LIBRARY_DIRS.contains(name)`, and the conjunction is
        // load-bearing. Weakened to a disjunction, *any* subdirectory reads as managed, so a folder
        // full of the user's own files would be accepted as a migration destination and the library
        // would be copied into it. The existing tests only ever placed managed directories or loose
        // files here, so nothing failed when that happened.
        let destination = unique_test_dir("dest-unrelated-dir");
        fs::create_dir_all(destination.join("Documents")).unwrap();

        let error = ensure_destination_is_migratable(&destination)
            .expect_err("a folder holding an unrelated directory must not be migratable");
        assert_eq!(error.code, AppErrorCode::InvalidLibraryMigration.as_str());

        let _ = fs::remove_dir_all(&destination);
    }

    #[test]
    fn ensure_destination_is_migratable_rejects_an_unrelated_file() {
        // The other half of the same condition. A loose file that is not OS litter is user content,
        // even when it is *named* like a managed directory (`video` as a file, not a folder).
        let destination = unique_test_dir("dest-unrelated-file");
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("contract.docx"), b"data").unwrap();

        let error = ensure_destination_is_migratable(&destination)
            .expect_err("a folder holding unrelated user content must not be migratable");
        assert_eq!(error.code, AppErrorCode::InvalidLibraryMigration.as_str());

        let named_like_managed = unique_test_dir("dest-file-named-video");
        fs::create_dir_all(&named_like_managed).unwrap();
        fs::write(named_like_managed.join("video"), b"data").unwrap();

        ensure_destination_is_migratable(&named_like_managed)
            .expect_err("a *file* named like a managed directory is still user content");

        let _ = fs::remove_dir_all(&destination);
        let _ = fs::remove_dir_all(&named_like_managed);
    }

    #[test]
    fn migrate_library_directory_sync_ignores_os_generated_files_in_destination() {
        let _guard = migration_test_lock().lock().unwrap();

        // A folder the user just browsed to in Finder/Explorer commonly already holds a `.DS_Store`
        // or `Thumbs.db` the OS created. It must still count as an empty, migratable destination.
        let new_root = unique_test_dir("os-files-dest");
        fs::create_dir_all(&new_root).unwrap();
        fs::write(new_root.join(".DS_Store"), b"os junk").unwrap();
        fs::write(new_root.join("Thumbs.db"), b"os junk").unwrap();

        let result =
            migrate_library_directory_sync("   ", new_root.to_string_lossy().as_ref(), None)
                .unwrap();

        assert!(result.changed);

        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn migrate_library_directory_sync_rejects_non_empty_destination() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("old-non-empty");
        let new_root = unique_test_dir("new-non-empty");

        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(&new_root).unwrap();
        fs::write(new_root.join("already-here.txt"), b"occupied").unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
        );

        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            AppErrorCode::InvalidLibraryMigration.as_str()
        );

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn migrate_library_directory_sync_recovers_from_a_poisoned_lock() {
        let _guard = migration_test_lock().lock().unwrap();

        // Simulate a previous migration that panicked mid-flight while holding the lock.
        let poisoning = std::thread::spawn(|| {
            let _held = library_migration_lock().lock().unwrap();
            panic!("simulated migration panic while holding the lock");
        })
        .join();
        assert!(poisoning.is_err(), "the helper thread should have panicked");
        assert!(library_migration_lock().is_poisoned());

        // The next migration must still succeed. The poison guards no real state, so it is
        // recovered instead of surfacing as a misleading "already running" error that would
        // wedge every future migration until the app restarts.
        let new_root = unique_test_dir("poison-recover");
        let result =
            migrate_library_directory_sync("   ", new_root.to_string_lossy().as_ref(), None)
                .unwrap();
        assert!(result.changed);

        // Leave the shared lock clean for any test that runs after this one.
        library_migration_lock().clear_poison();

        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn the_current_library_under_another_spelling_is_refused() {
        let root = unique_test_dir("alias-same");
        fs::create_dir_all(root.join("video")).unwrap();
        fs::write(root.join("video").join("a.mp4"), b"video").unwrap();

        // `video/..` names the library root without being spelled like it, the way a second UNC
        // host name or a mapped drive does for a share.
        let alias = root.join("video").join("..");

        let error = ensure_distinct_directories(&root, &alias).unwrap_err();

        assert_eq!(
            error.code,
            AppErrorCode::LibraryMigrationSameFolder.as_str()
        );
        assert_eq!(
            fs::read(root.join("video").join("a.mp4")).unwrap(),
            b"video"
        );
        assert_eq!(
            fs::read_dir(&root).unwrap().count(),
            1,
            "the probe file was removed"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_destination_inside_the_current_library_under_another_spelling_is_refused() {
        let root = unique_test_dir("alias-inside");
        fs::create_dir_all(root.join("video")).unwrap();
        fs::create_dir_all(root.join("elsewhere")).unwrap();

        let inside = root.join("video").join("..").join("elsewhere");

        let error = ensure_distinct_directories(&root, &inside).unwrap_err();

        assert_eq!(
            error.code,
            AppErrorCode::LibraryMigrationSameFolder.as_str()
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_destination_above_the_current_library_under_another_spelling_is_refused() {
        let parent = unique_test_dir("alias-above");
        let library = parent.join("library");
        fs::create_dir_all(library.join("video")).unwrap();

        let above = library.join("video").join("..").join("..");

        let error = ensure_distinct_directories(&library, &above).unwrap_err();

        assert_eq!(
            error.code,
            AppErrorCode::LibraryMigrationSameFolder.as_str()
        );

        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn two_unrelated_folders_are_distinct_and_the_probe_is_cleaned_up() {
        let old_root = unique_test_dir("distinct-old");
        let new_root = unique_test_dir("distinct-new");
        fs::create_dir_all(&old_root).unwrap();
        fs::create_dir_all(&new_root).unwrap();

        ensure_distinct_directories(&old_root, &new_root).unwrap();

        assert_eq!(fs::read_dir(&new_root).unwrap().count(), 0);

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    // A directory symlink needs Developer Mode or admin on Windows, so this runs where one can
    // always be made. The refusal itself is platform independent (`dir_entry_is_symlink`).
    #[cfg(unix)]
    #[test]
    fn a_managed_folder_in_the_destination_that_is_a_link_is_refused() {
        let old_root = unique_test_dir("linked-old");
        let new_root = unique_test_dir("linked-new");
        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video").unwrap();
        fs::create_dir_all(&new_root).unwrap();
        std::os::unix::fs::symlink(old_root.join("video"), new_root.join("video")).unwrap();

        let error = ensure_destination_is_migratable(&new_root).unwrap_err();

        assert_eq!(
            error.code,
            AppErrorCode::LibraryMigrationSameFolder.as_str()
        );

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    #[cfg(unix)]
    #[test]
    fn a_library_entry_that_is_neither_file_nor_folder_stops_the_migration_before_removal() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("fifo-old");
        let new_root = unique_test_dir("fifo-new");
        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video").unwrap();

        let fifo = std::ffi::CString::new(
            old_root
                .join("video")
                .join("pipe")
                .to_string_lossy()
                .as_bytes(),
        )
        .unwrap();
        // SAFETY: `fifo` is a NUL-terminated path that outlives the call.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
        );

        assert!(result.is_err());
        assert!(old_root.join("video").join("a.mp4").exists());
        assert!(old_root.join("video").join("pipe").exists());

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    // A file symlink needs Developer Mode or admin on Windows. The refusal itself is platform
    // independent (`dir_entry_is_symlink`).
    #[cfg(unix)]
    #[test]
    fn a_library_holding_a_link_to_a_file_is_not_moved() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("file-link-old");
        let new_root = unique_test_dir("file-link-new");
        let elsewhere = unique_test_dir("file-link-target");
        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(old_root.join("video").join("a.mp4"), b"video").unwrap();
        fs::write(elsewhere.join("b.mp4"), b"linked video").unwrap();
        std::os::unix::fs::symlink(
            elsewhere.join("b.mp4"),
            old_root.join("video").join("b.mp4"),
        )
        .unwrap();

        let result = migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
        );

        assert!(result.is_err(), "a move would have dropped the linked file");
        assert!(old_root.join("video").join("a.mp4").exists());
        assert!(fs::symlink_metadata(old_root.join("video").join("b.mp4")).is_ok());

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
        let _ = fs::remove_dir_all(elsewhere);
    }

    #[test]
    fn the_trash_moves_with_the_library() {
        let _guard = migration_test_lock().lock().unwrap();

        let old_root = unique_test_dir("trash-old");
        let new_root = unique_test_dir("trash-new");
        let trashed = Path::new(LIBRARY_TRASH_DIR)
            .join("20261010T120000Z-1")
            .join("video")
            .join("media_a.mp4");
        fs::create_dir_all(old_root.join("video")).unwrap();
        fs::write(old_root.join("video").join("media_b.mp4"), b"kept").unwrap();
        fs::create_dir_all(old_root.join(trashed.parent().unwrap())).unwrap();
        fs::write(old_root.join(&trashed), b"trashed").unwrap();

        migrate_library_directory_sync(
            old_root.to_string_lossy().as_ref(),
            new_root.to_string_lossy().as_ref(),
            None,
        )
        .expect("a library with a trash folder moves");

        assert_eq!(fs::read(new_root.join(&trashed)).unwrap(), b"trashed");
        assert!(
            !old_root.join(LIBRARY_TRASH_DIR).exists(),
            "nothing is left behind for no sweep to reach"
        );

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn a_folder_holding_only_a_trash_is_a_destination_a_move_can_resume_into() {
        let root = unique_test_dir("trash-destination");
        fs::create_dir_all(root.join(LIBRARY_TRASH_DIR)).unwrap();

        ensure_destination_is_migratable(&root).expect("the trash is the app's own folder");

        let _ = fs::remove_dir_all(root);
    }
}
