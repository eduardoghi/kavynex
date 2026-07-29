//! Crash recovery for the artifacts a media creation prepared but never registered.
//!
//! Creating a media is not one call: the frontend prepares the artifacts (downloading or copying
//! the media file into the library, plus its thumbnail and live chat replay) and only then inserts
//! the row. Between those two steps the files exist in the library with nothing pointing at them.
//! The frontend's `catch` cleans that up when a step *fails*, but a `catch` only runs if the process
//! survives - close the window, lose power, or have the OS kill the webview in that window and a
//! multi-GB video is stranded in the library forever, discoverable only by running Diagnostics by
//! hand.
//!
//! So the intent is recorded on disk instead. Once the artifacts exist and before the row is
//! inserted, a marker naming them is written to the app cache directory; it is removed as soon as
//! the row lands (or the failure path has cleaned up). A marker still present at the next startup
//! is therefore a creation that died in exactly that window, and the sweep below hands its paths to
//! the same reference-counting cleanup the manual path uses.
//!
//! That reuse is the safety property: `cleanup_unreferenced_artifacts` deletes a file only when no
//! row references it, so a marker that outlived a creation which actually *succeeded* (the row was
//! inserted, the clear call was lost) deletes nothing. The sweep can be wrong about what happened
//! without being able to destroy anything the library still needs.
//!
//! It is *not* free to be wrong about *which* marker is a leftover, though, and that is what
//! [`marker_is_sweepable`] decides. Reference-counting cannot tell a creation that died before its
//! row from one that has simply not reached `insert_media` yet - both have artifacts on disk with
//! nothing pointing at them. So a marker belonging to a creation still in flight must never be
//! consumed: the sweep would unlink the file the user is adding right now, then remove the marker,
//! and the row that lands moments later would point at nothing with nothing left to reconcile it.
//! Two independent filters keep that out: the in-memory set of markers this process wrote and has
//! not cleared, and a refusal to touch anything whose mtime is not older than this process.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::services::logger;
use crate::utils::naming::unique_temp_suffix;
use crate::utils::path::ensure_managed_library_relative_path;
use crate::{AppError, AppErrorCode, AppResult};

/// The library-relative artifacts one in-flight media creation had already written when the marker
/// was recorded. All three are optional: a creation can legitimately produce no thumbnail and no
/// live chat replay.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingMediaArtifacts {
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub thumbnail_path: Option<String>,
    #[serde(default)]
    pub live_chat_file_path: Option<String>,
}

impl PendingMediaArtifacts {
    fn is_empty(&self) -> bool {
        self.file_path.is_none()
            && self.thumbnail_path.is_none()
            && self.live_chat_file_path.is_none()
    }
}

/// Keeps only a path that is a well-formed library-relative path inside one of the managed
/// subdirectories, mapping anything else to `None`.
///
/// Applied both when recording (so a malformed value never reaches the marker) and when sweeping
/// (so a hand-edited or corrupted marker cannot name something outside the app's own layout). The
/// cleanup this feeds re-checks containment itself before unlinking; this is the cheaper, earlier
/// refusal, and it is what keeps the marker file from being a way to ask the app to delete an
/// arbitrary path.
fn managed_path_or_none(value: Option<String>) -> Option<String> {
    let trimmed = value?.trim().to_string();

    if trimmed.is_empty() || ensure_managed_library_relative_path(&trimmed).is_err() {
        return None;
    }

    Some(trimmed)
}

/// Drops every path that is not a managed library-relative path. Pure, so the refusal can be
/// tested without a Tauri runtime or a filesystem.
pub(crate) fn sanitize_pending_artifacts(
    artifacts: PendingMediaArtifacts,
) -> PendingMediaArtifacts {
    PendingMediaArtifacts {
        file_path: managed_path_or_none(artifacts.file_path),
        thumbnail_path: managed_path_or_none(artifacts.thumbnail_path),
        live_chat_file_path: managed_path_or_none(artifacts.live_chat_file_path),
    }
}

/// Parses a marker's contents, dropping any path it should not name. Returns `None` for a marker
/// that does not parse or that names nothing usable, so a damaged file is skipped rather than
/// failing the whole sweep.
pub(crate) fn decode_marker(contents: &str) -> Option<PendingMediaArtifacts> {
    let parsed: PendingMediaArtifacts = serde_json::from_str(contents).ok()?;
    let sanitized = sanitize_pending_artifacts(parsed);

    if sanitized.is_empty() {
        return None;
    }

    Some(sanitized)
}

/// True for a file name this module wrote. The sweep only consumes its own markers, so an
/// unrelated file that ends up in the directory is left alone rather than deleted.
pub(crate) fn is_marker_file_name(name: &str) -> bool {
    name.starts_with("pending-") && name.ends_with(".json")
}

/// The names of the markers this process wrote and has not cleared yet, i.e. the creations still in
/// flight right now.
///
/// This is the first of the two filters described in the module docs, and the precise one: the
/// process knows exactly which creations it started, so consulting that beats inferring it. A name
/// is registered before its file exists and removed when the creation resolves, so there is never a
/// moment where a marker is on disk without being known as in flight.
fn live_markers() -> &'static Mutex<HashSet<String>> {
    static LIVE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// The critical sections are a single insert/remove/contains, so a panic inside one is not a real
/// possibility; recover the guard rather than let poisoning propagate into the sweep, which must
/// stay best effort.
fn lock_live_markers() -> MutexGuard<'static, HashSet<String>> {
    live_markers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_live_marker(name: &str) -> bool {
    lock_live_markers().contains(name)
}

/// The instant this process started, used as the cutoff by [`marker_is_sweepable`].
///
/// Pinned through [`pin_process_start`] from `lib.rs`'s `setup()` rather than left to initialize
/// lazily: the first caller would otherwise be the sweep itself, half a minute into the session, and
/// every marker this session had written before that point would read as older than "process start"
/// and become sweepable - defeating the filter exactly when it is needed.
fn process_start() -> SystemTime {
    static START: OnceLock<SystemTime> = OnceLock::new();
    *START.get_or_init(SystemTime::now)
}

/// Records the process-start instant while it is still accurate. Call once, early in `setup()`.
pub fn pin_process_start() {
    let _ = process_start();
}

/// Decides whether the sweep may consume a marker: only one that no in-flight creation owns *and*
/// that predates this process, which together mean it can only have been left by an earlier run.
///
/// Pure so both directions can be pinned by a test without a Tauri runtime, and so the decision that
/// gates an unlink of the user's media is a function rather than a condition buried in a loop.
///
/// Every uncertain case answers "not sweepable". An unreadable mtime, a marker written in the same
/// coarse filesystem tick as the process start, or a clock that moved backwards between runs all
/// leave the marker in place: the cost is a leftover reconciled one launch later, whereas acting on
/// a wrong answer deletes a file the user still wants.
pub(crate) fn marker_is_sweepable(
    is_live: bool,
    modified_at: Option<SystemTime>,
    process_start: SystemTime,
) -> bool {
    if is_live {
        return false;
    }

    match modified_at {
        Some(modified_at) => modified_at < process_start,
        None => false,
    }
}

/// When `path` was last modified, or `None` if that cannot be read.
fn marker_modified_at(path: &Path) -> Option<SystemTime> {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
}

fn pending_media_dir<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| {
        AppError::from_code(
            AppErrorCode::CacheDirectoryResolveFailed,
            format!("failed to resolve cache directory: {e}"),
        )
    })?;

    let dir = cache_dir.join(crate::constants::TEMP_DIR_PENDING_MEDIA);

    fs::create_dir_all(&dir).map_err(|e| {
        AppError::from_code(
            AppErrorCode::CreateTempDirFailed,
            format!("failed to create the pending media directory: {e}"),
        )
    })?;

    Ok(dir)
}

/// Records the artifacts an in-flight creation has already written and returns the marker's name,
/// which the caller passes back to [`clear_pending_media_artifacts`] once the row is registered.
///
/// Written with `sync_all` plus a parent-directory fsync: the window this guards is a process that
/// dies moments later, so a marker still sitting in the OS write cache - or whose directory entry
/// was never flushed - would be exactly as absent as not writing one at all.
pub fn record_pending_media_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    artifacts: PendingMediaArtifacts,
) -> AppResult<String> {
    let sanitized = sanitize_pending_artifacts(artifacts);

    if sanitized.is_empty() {
        return Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            "no managed library artifact was named",
        ));
    }

    let dir = pending_media_dir(app)?;
    let name = format!("pending-{}.json", unique_temp_suffix());
    let marker = dir.join(&name);

    let contents = serde_json::to_string(&sanitized).map_err(|e| {
        AppError::from_code(
            AppErrorCode::InvalidInput,
            format!("failed to encode the pending media marker: {e}"),
        )
    })?;

    // Registered before the file exists, so the sweep can never observe a marker on disk that is not
    // yet known to belong to a creation in flight. Rolled back on the failure path below.
    lock_live_markers().insert(name.clone());

    if let Err(error) = write_marker_file(&marker, &contents) {
        lock_live_markers().remove(&name);
        return Err(error);
    }

    Ok(name)
}

/// Writes the marker durably: contents, `sync_all`, then a parent-directory fsync. Split out so the
/// caller can roll its live-marker registration back on failure without duplicating the error mapping.
fn write_marker_file(marker: &Path, contents: &str) -> AppResult<()> {
    use std::io::Write;

    let write_failed = |e: std::io::Error| {
        AppError::from_code(
            AppErrorCode::FileOpenFailed,
            format!("failed to write the pending media marker: {e}"),
        )
    };

    let mut file = fs::File::create(marker).map_err(write_failed)?;

    file.write_all(contents.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(write_failed)?;

    crate::services::filesystem::fsync_parent_dir(marker);

    Ok(())
}

/// Removes a marker once its creation has finished - either the row was inserted, or the failure
/// path already cleaned the artifacts up. A missing marker is not an error: the sweep may have
/// consumed it, and the caller has nothing to do about it either way.
pub fn clear_pending_media_artifacts<R: Runtime>(
    app: &AppHandle<R>,
    marker: &str,
) -> AppResult<()> {
    if !is_marker_file_name(marker) {
        return Err(AppError::from_code(
            AppErrorCode::InvalidInput,
            "not a pending media marker name",
        ));
    }

    // The creation has resolved either way, so it is no longer in flight. Dropped unconditionally,
    // before the unlink: if the unlink fails the marker stays on disk, and leaving it registered would
    // pin it in memory for the rest of the session for no benefit - its mtime already keeps this
    // session's sweep off it, and the next launch reconciles it as the leftover it now is.
    lock_live_markers().remove(marker);

    let path = pending_media_dir(app)?.join(marker);

    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::from_code(
            AppErrorCode::RemoveMediaFailed,
            format!("failed to clear the pending media marker: {error}"),
        )),
    }
}

/// Reads every marker left behind by a previous run and returns what each one named, together with
/// its file name. Unreadable or malformed markers are skipped and reported in the log rather than
/// failing the sweep.
///
/// "Left behind by a previous run" is the load-bearing part, and [`marker_is_sweepable`] is what
/// enforces it: a marker belonging to a creation this process still has in flight is skipped, so the
/// sweep can never hand its artifacts to a reference count that has not seen its row yet.
fn read_pending_markers<R: Runtime>(
    app: &AppHandle<R>,
) -> AppResult<Vec<(String, PendingMediaArtifacts)>> {
    let dir = pending_media_dir(app)?;
    let mut markers = Vec::new();

    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(markers),
        Err(error) => {
            return Err(AppError::from_code(
                AppErrorCode::ReadDirFailed,
                format!("failed to read the pending media directory: {error}"),
            ))
        }
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        if !is_marker_file_name(&name) || !path.is_file() {
            continue;
        }

        if !marker_is_sweepable(
            is_live_marker(&name),
            marker_modified_at(&path),
            process_start(),
        ) {
            continue;
        }

        match fs::read_to_string(&path).ok().as_deref() {
            Some(contents) => match decode_marker(contents) {
                Some(artifacts) => markers.push((name, artifacts)),
                // A marker that names nothing usable has no work behind it; drop the file so it is
                // not re-read on every launch.
                None => markers.push((name, PendingMediaArtifacts::default())),
            },
            None => logger::warn(
                "pending_media",
                format!("could not read the pending media marker {name}; leaving it in place"),
            ),
        }
    }

    Ok(markers)
}

/// Sweeps the markers a previous run left behind, removing any artifact no row references.
///
/// Best effort throughout: this runs off the startup path and a failure never affects the app. The
/// deletion decision is not made here - it is delegated to the same reference-counting cleanup the
/// manual path uses, which keeps any file a registered row still points at. A marker is cleared once
/// its paths have been handled, whether or not anything was actually deleted.
pub async fn sweep_pending_media_artifacts(app: &AppHandle) -> AppResult<usize> {
    let markers = read_pending_markers(app)?;
    let mut removed_artifacts = 0usize;

    for (name, artifacts) in markers {
        if !artifacts.is_empty() {
            match crate::services::library_cleanup::cleanup_unreferenced_artifacts(
                app,
                artifacts.file_path.clone(),
                artifacts.thumbnail_path.clone(),
                artifacts.live_chat_file_path.clone(),
            )
            .await
            {
                Ok(report) => {
                    removed_artifacts += report.deleted_paths.len();

                    if !report.deleted_paths.is_empty() {
                        logger::info(
                            "pending_media",
                            format!(
                                "removed {} artifact(s) left by a media creation that never finished",
                                report.deleted_paths.len()
                            ),
                        );
                    }
                }
                Err(error) => {
                    // Leave the marker in place so the next launch retries; a transient failure
                    // (the library drive not mounted yet) must not silently drop the record.
                    logger::warn(
                        "pending_media",
                        format!("could not reconcile a pending media marker: {error}"),
                    );
                    continue;
                }
            }
        }

        if let Err(error) = clear_pending_media_artifacts(app, &name) {
            logger::warn(
                "pending_media",
                format!("could not clear a pending media marker: {error}"),
            );
        }
    }

    Ok(removed_artifacts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    /// A mock app is enough for the record/clear round trip: those only need `app.path()` and the
    /// filesystem. Only the markers this test wrote are removed - the cache directory is the real
    /// per-OS one, shared with a running app, so the tree is never wiped.
    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        mock_builder().build(mock_context(noop_assets())).unwrap()
    }

    /// Backdates a marker so it reads as written before this process started, which is what makes it
    /// a leftover of an earlier run as far as `marker_is_sweepable` is concerned. A freshly written
    /// file is always newer than `process_start()` in a test, so a leftover has to be simulated.
    fn set_modified_before_process_start(path: &Path) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(process_start() - Duration::from_secs(3600))
            .unwrap();
    }

    fn artifacts(
        file: Option<&str>,
        thumb: Option<&str>,
        chat: Option<&str>,
    ) -> PendingMediaArtifacts {
        PendingMediaArtifacts {
            file_path: file.map(str::to_string),
            thumbnail_path: thumb.map(str::to_string),
            live_chat_file_path: chat.map(str::to_string),
        }
    }

    #[test]
    fn sanitize_keeps_managed_library_paths() {
        let kept = sanitize_pending_artifacts(artifacts(
            Some("video/media_abc.mp4"),
            Some("thumbnails/thumb_abc.jpg"),
            Some("live_chat/clip.live_chat.json.gz"),
        ));

        assert_eq!(kept.file_path.as_deref(), Some("video/media_abc.mp4"));
        assert_eq!(
            kept.thumbnail_path.as_deref(),
            Some("thumbnails/thumb_abc.jpg")
        );
        assert_eq!(
            kept.live_chat_file_path.as_deref(),
            Some("live_chat/clip.live_chat.json.gz")
        );
    }

    #[test]
    fn sanitize_drops_anything_outside_the_managed_layout() {
        // A marker is a file on disk. If it could name an arbitrary path, it would be a way to ask
        // the app to delete one - so a traversal, an absolute path, a bare filename at the library
        // root and an unmanaged subdirectory are all dropped rather than passed on.
        let dropped = sanitize_pending_artifacts(artifacts(
            Some("../../etc/passwd"),
            Some("C:\\Windows\\System32\\config"),
            Some("Documents/secret.txt"),
        ));

        assert_eq!(dropped, PendingMediaArtifacts::default());

        let bare = sanitize_pending_artifacts(artifacts(Some("contract.docx"), None, Some("   ")));
        assert_eq!(bare, PendingMediaArtifacts::default());
    }

    #[test]
    fn decode_marker_round_trips_what_record_would_write() {
        let original = artifacts(Some("video/media_abc.mp4"), None, None);
        let encoded = serde_json::to_string(&original).unwrap();

        assert_eq!(decode_marker(&encoded), Some(original));
    }

    #[test]
    fn decode_marker_rejects_damaged_and_empty_markers() {
        assert_eq!(decode_marker("not json"), None);
        assert_eq!(decode_marker("{}"), None);
        // Parses, but names nothing the sweep may act on.
        assert_eq!(decode_marker(r#"{"file_path":"../escape"}"#), None);
    }

    #[test]
    fn a_recorded_marker_is_not_swept_while_its_creation_is_in_flight() {
        // The whole point of the two filters: between recording the marker and inserting the row the
        // artifacts are in the library with nothing pointing at them, which is indistinguishable from
        // a creation that died there. If the sweep consumed this marker it would unlink the file the
        // user is adding right now and then delete the marker, leaving the row that lands moments
        // later pointing at nothing and nothing behind to reconcile it.
        let app = mock_app();
        let handle = app.handle();

        let recorded = artifacts(
            Some("video/media_roundtrip.mp4"),
            Some("thumbnails/thumb_roundtrip.jpg"),
            None,
        );
        let name = record_pending_media_artifacts(handle, recorded).unwrap();
        assert!(is_marker_file_name(&name));

        assert!(
            !read_pending_markers(handle)
                .unwrap()
                .iter()
                .any(|(marker_name, _)| marker_name == &name),
            "a marker whose creation is still in flight must not be swept"
        );

        clear_pending_media_artifacts(handle, &name).unwrap();

        assert!(
            !read_pending_markers(handle)
                .unwrap()
                .iter()
                .any(|(marker_name, _)| marker_name == &name),
            "a cleared marker must not be read back"
        );

        // Clearing an already-cleared marker succeeds: the sweep may have consumed it first, and
        // the caller has nothing to do about that either way.
        clear_pending_media_artifacts(handle, &name).unwrap();
    }

    #[test]
    fn an_in_flight_marker_is_held_out_even_once_it_is_older_than_the_process() {
        // Isolates the first of the two filters, which the sibling test above cannot. That one
        // records a marker and finds it excluded - but the file it just wrote is newer than the
        // process, so the mtime filter would have excluded it too. Both filters agree there, so the
        // assertion passes whichever one actually acted, and it passes just as happily if the
        // in-flight registration stops working altogether.
        //
        // Backdating the file removes that cover: the mtime now says "leftover" (exactly what
        // `a_marker_left_by_a_previous_run_is_read_back` below relies on to get a marker read back),
        // so a marker still held out here can only be the live registration doing it.
        //
        // What that registration guards is the project's one real CRITICAL: a sweep that consumes a
        // marker belonging to a creation still in flight unlinks the file the user is adding right
        // now and deletes the marker, leaving the row that lands moments later pointing at nothing
        // with nothing left to reconcile it.
        let app = mock_app();
        let handle = app.handle();

        let recorded = artifacts(Some("video/media_in_flight.mp4"), None, None);
        let name = record_pending_media_artifacts(handle, recorded).unwrap();
        let marker = pending_media_dir(handle).unwrap().join(&name);

        set_modified_before_process_start(&marker);

        assert!(
            !read_pending_markers(handle)
                .unwrap()
                .iter()
                .any(|(marker_name, _)| marker_name == &name),
            "a marker registered as in flight must be held out by that registration alone, even \
             once its file is older than the process"
        );

        clear_pending_media_artifacts(handle, &name).unwrap();
    }

    #[test]
    fn a_marker_left_by_a_previous_run_is_read_back() {
        // The counterpart to the test above, and it is what keeps that filter from silently turning
        // the sweep off altogether: a marker that really is a leftover - not registered as in flight,
        // and older than this process - must still be picked up with exactly what it named.
        let app = mock_app();
        let handle = app.handle();

        let leftover = artifacts(Some("video/media_leftover.mp4"), None, None);
        let name = format!("pending-{}.json", unique_temp_suffix());
        let marker = pending_media_dir(handle).unwrap().join(&name);

        // Written directly rather than through record_pending_media_artifacts, which would register
        // it as in flight: this simulates the file an earlier run left behind.
        fs::write(&marker, serde_json::to_string(&leftover).unwrap()).unwrap();
        set_modified_before_process_start(&marker);

        let found = read_pending_markers(handle)
            .unwrap()
            .into_iter()
            .find(|(marker_name, _)| marker_name == &name);
        assert_eq!(found, Some((name.clone(), leftover)));

        clear_pending_media_artifacts(handle, &name).unwrap();
    }

    #[test]
    fn an_unrelated_file_in_the_directory_is_never_read_as_a_marker() {
        // The sweep hands whatever this returns to a cleanup that unlinks files, so it must only
        // ever recognize this module's own markers. The name filter is what enforces that, and it
        // is worth pinning here rather than only on `is_marker_file_name` in isolation: the guard
        // that applies it also tests `path.is_file()`, and weakening the `||` between them to `&&`
        // makes a file with an unrelated name fall through and be parsed as a marker anyway. The
        // contents are deliberately a *valid* marker payload, so nothing downstream would reject it.
        let app = mock_app();
        let handle = app.handle();

        let payload = artifacts(Some("video/media_unrelated.mp4"), None, None);
        let intruder = pending_media_dir(handle).unwrap().join("notes.txt");

        fs::write(&intruder, serde_json::to_string(&payload).unwrap()).unwrap();
        set_modified_before_process_start(&intruder);

        let found = read_pending_markers(handle)
            .unwrap()
            .into_iter()
            .any(|(marker_name, _)| marker_name == "notes.txt");

        assert!(
            !found,
            "a file whose name is not a pending marker must not be read as one"
        );

        let _ = fs::remove_file(&intruder);
    }

    #[test]
    fn marker_is_sweepable_only_for_a_leftover_of_an_earlier_run() {
        let start = SystemTime::now();
        let before = start - Duration::from_secs(60);
        let after = start + Duration::from_secs(60);

        // The only sweepable combination: not in flight, and written before this process existed.
        assert!(marker_is_sweepable(false, Some(before), start));

        // In flight, whatever the mtime says.
        assert!(!marker_is_sweepable(true, Some(before), start));
        assert!(!marker_is_sweepable(true, Some(after), start));

        // This session's own marker, and the same-tick boundary: `<` is what keeps a marker written
        // in the very tick of the process start out of the sweep.
        assert!(!marker_is_sweepable(false, Some(after), start));
        assert!(!marker_is_sweepable(false, Some(start), start));

        // An unreadable mtime answers "leave it alone": acting on a wrong answer here deletes a file
        // the user still wants, while refusing only defers the leftover by one launch.
        assert!(!marker_is_sweepable(false, None, start));
    }

    #[test]
    fn clearing_refuses_a_name_that_is_not_a_marker() {
        // The name comes back over IPC, so a traversal or an arbitrary file name must not become a
        // delete inside the cache directory.
        let app = mock_app();
        let handle = app.handle();

        for name in ["../../kavynex.db", "kavynex.db", "pending-x.json.bak", ""] {
            assert!(
                clear_pending_media_artifacts(handle, name).is_err(),
                "should refuse: {name}"
            );
        }
    }

    #[test]
    fn recording_refuses_when_no_managed_artifact_is_named() {
        // Nothing to reconcile later, so writing a marker would only leave a file the sweep has to
        // read and discard on every launch.
        let app = mock_app();
        let handle = app.handle();

        assert!(record_pending_media_artifacts(handle, PendingMediaArtifacts::default()).is_err());
        assert!(
            record_pending_media_artifacts(handle, artifacts(Some("../escape"), None, None))
                .is_err()
        );
    }

    #[test]
    fn is_marker_file_name_matches_only_this_modules_files() {
        assert!(is_marker_file_name("pending-123-456-0.json"));

        for name in [
            "pending-123",      // no extension
            "other-123.json",   // not ours
            "pending.json.tmp", // wrong extension
            "..",
            "",
        ] {
            assert!(!is_marker_file_name(name), "should not match: {name}");
        }
    }
}
