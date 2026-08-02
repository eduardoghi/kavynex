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
use tauri::{AppHandle, Emitter, Manager, Runtime};

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
    /// How many launches have already tried and failed to reconcile this marker. Written back by
    /// the sweep, never by the caller that records the marker (see
    /// [`record_pending_media_artifacts`], which zeroes it), and defaulted so a marker written
    /// before this field existed reads as a first attempt rather than failing to parse.
    #[serde(default)]
    pub attempts: u32,
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
        // Carried through rather than reset: this runs on the decode path too, where dropping the
        // count would restart the retry budget on every launch and reinstate the forever-retry this
        // field exists to end. The record path zeroes it explicitly instead.
        attempts: artifacts.attempts,
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

/// How many launches may fail to reconcile one marker before the sweep stops retrying it.
///
/// The retry exists for the transient case - the library drive not mounted yet, a lock still held -
/// which resolves within a launch or two. A failure that survives this many is not transient: the
/// library was repointed, or the path went permanently invalid. Retrying it forever turns a one-off
/// failure into a tax on every launch, with nothing but a `warn` line nobody reads to show for it.
///
/// What this counts is therefore a property of *one marker*, and one class of failure had to be
/// kept out of it because it is a property of the run instead: a database that will not open fails
/// every marker identically, so passing it through the loop would spend an attempt per marker on a
/// verdict none of them earned. [`sweep_pending_media_artifacts`] refuses before the loop for that
/// reason rather than classifying the error afterwards.
///
/// What this ceiling bounds is the *retrying*, and it is worth being exact about that because it is
/// easy to read as bounding more. The directory itself is unbounded: an abandoned marker is
/// deliberately left on disk (see [`marker_retries_are_exhausted`]), and `services::cleanup`'s
/// startup sweep does not reach it either - that sweep covers the three scratch directories by age
/// and the display cache by size, and `pending-media/` is in neither list, by design, since it is
/// the one cache directory whose contents are a record rather than a derivative.
///
/// So the set of abandoned markers only grows. That is the accepted side of the trade rather than an
/// oversight, and it is cheap on both counts: a marker is a couple of hundred bytes, and reaching
/// one takes a media creation that crashed *and* five consecutive launches that could not reconcile
/// it. Against that, a sweep able to delete these files would be a sweep able to delete the only
/// record of artifacts sitting in the user's library - which is exactly the decision
/// [`marker_is_sweepable`] refuses to make on anything uncertain. Diagnostics is what reports and
/// removes what an abandoned marker names.
const MAX_MARKER_SWEEP_ATTEMPTS: u32 = 5;

/// Payload of the [`EVENT_PENDING_MEDIA_ABANDONED`](crate::constants::EVENT_PENDING_MEDIA_ABANDONED)
/// event: how many markers this sweep gave up on.
///
/// The count and nothing else. The paths would be library-relative names of files the user cannot
/// act on from a banner, and Diagnostics is the one place that can both name them and remove them -
/// so the event says that something is there and the dialog says what, rather than the banner trying
/// to be the dialog. Frontend-owned contract, like the integrity event, so it is a plain serde struct
/// rather than a ts-rs export.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingMediaAbandonedEvent {
    abandoned: usize,
}

/// Whether a marker has been retried enough times that its failure is not transient.
///
/// Pure so both directions are pinned by a test, matching [`marker_is_sweepable`] next door - and
/// for the same reason: the decision sits in front of artifacts belonging to the user, so it should
/// be a function rather than a comparison buried in a loop.
///
/// Reaching the ceiling abandons the *record*, never the files. The marker is deliberately left on
/// disk: it names artifacts in the user's library, and giving up on reconciling them is not the
/// same as being allowed to remove them. What changes is that the failure is logged at `error`
/// once, with its count, instead of at `warn` on every launch forever.
///
/// "Once" is only true because the count is persisted at the same moment and this predicate is
/// consulted again by [`read_pending_markers`], which drops an exhausted marker before the sweep can
/// see it. Without both halves the ceiling decides nothing: the marker would be re-read at one below
/// it on every launch, retry the same failing cleanup, and re-emit the user-facing notice each time -
/// strictly worse than the unbounded `warn` line this was meant to replace.
pub(crate) fn marker_retries_are_exhausted(attempts: u32) -> bool {
    attempts >= MAX_MARKER_SWEEP_ATTEMPTS
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
    let sanitized = PendingMediaArtifacts {
        // A fresh record always starts its retry budget at zero, whatever the caller passed. The
        // count is the sweep's own bookkeeping, and a caller able to pre-set it could hand over a
        // marker that is abandoned on its first failure - quietly turning off the recovery this
        // whole module exists for.
        attempts: 0,
        ..sanitize_pending_artifacts(artifacts)
    };

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

/// Rewrites a marker with an incremented attempt count, so the ceiling survives a restart.
///
/// Best effort by design, like everything else the sweep does: if this fails, the marker keeps its
/// previous count and simply gets one more attempt than it should. That is the harmless direction -
/// the alternative, treating a failed rewrite as a reason to give up, would abandon a record over a
/// transient write error, which is exactly the mistake the retry exists to avoid.
///
/// The rewrite refreshes the marker's mtime, which is deliberate and safe: `marker_is_sweepable`
/// compares that against the *process* start, so a marker touched during this run is skipped by
/// this run's remaining work (there is none - the sweep runs once) and is sweepable again on the
/// next launch, whose process start is later.
fn record_marker_attempt<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    artifacts: &PendingMediaArtifacts,
    attempts: u32,
) {
    let updated = PendingMediaArtifacts {
        attempts,
        ..artifacts.clone()
    };

    let Ok(dir) = pending_media_dir(app) else {
        return;
    };

    let Ok(contents) = serde_json::to_string(&updated) else {
        return;
    };

    if let Err(error) = write_marker_file(&dir.join(name), &contents) {
        logger::warn(
            "pending_media",
            format!("could not record a pending media marker attempt: {error}"),
        );
    }
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
                Some(artifacts) if marker_retries_are_exhausted(artifacts.attempts) => {
                    // Already given up on by an earlier launch. Offering it again would re-run the
                    // cleanup that has failed every time, and - since the sweep reports abandoning
                    // it - would put an error line and a user-facing notice on every launch for the
                    // rest of the library's life. The marker stays on disk regardless: it names
                    // artifacts in the user's library, which Diagnostics is what reports and removes.
                    continue;
                }
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
///
/// Generic over the runtime so the database-unavailable branch below can be driven by a test; see
/// `library::cleanup::cleanup_unreferenced_artifacts`, which had to be widened for the same reason.
pub async fn sweep_pending_media_artifacts<R: Runtime>(app: &AppHandle<R>) -> AppResult<usize> {
    // Asked once, up front, and the whole sweep gives up when the answer is no.
    //
    // [`MAX_MARKER_SWEEP_ATTEMPTS`] bounds how often *one marker* may fail to reconcile, on the
    // reasoning that a failure surviving that many launches is a property of that marker - a path
    // gone permanently invalid, a library repointed. A database that will not open is the opposite
    // kind of failure: it has nothing to do with any particular marker, it fails every one of them
    // identically, and it is resolved elsewhere entirely (the recovery modal offers a restore on the
    // very same launch). Letting it through the loop would spend an attempt per marker per launch on
    // a verdict none of them earned, and five such launches would abandon every pending record the
    // library holds at once - each one naming artifacts that are still on disk and still
    // reconcilable the moment the database is back.
    //
    // So it is not classified after the fact, it is refused before the loop: nothing is read,
    // nothing is counted, and every marker is left exactly as it was for the next launch.
    if let Err(error) = crate::services::database::shared_pool(app).await {
        logger::warn(
            "pending_media",
            format!(
                "the database is not available, so nothing can be reconciled; leaving every \
                 pending marker untouched for the next launch: {error}"
            ),
        );

        return Ok(0);
    }

    let markers = read_pending_markers(app)?;
    let mut removed_artifacts = 0usize;
    let mut abandoned_markers = 0usize;

    for (name, artifacts) in markers {
        if !artifacts.is_empty() {
            match crate::services::library::cleanup::cleanup_unreferenced_artifacts(
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
                    // (the library drive not mounted yet) must not silently drop the record. What
                    // the count adds is an end to that: nothing here can tell transient from
                    // permanent, so a failure that keeps recurring is reclassified by how often it
                    // has, and reported once instead of every launch.
                    let attempts = artifacts.attempts.saturating_add(1);

                    // Written back in both branches, and the exhausted one is why: without it the
                    // marker stays at one below the ceiling forever, so every later launch re-runs
                    // the same failing cleanup, logs the same error and re-emits the notice below.
                    // The count is what `read_pending_markers` reads to stop offering this marker at
                    // all, so persisting it is the whole of what "giving up" means.
                    record_marker_attempt(app, &name, &artifacts, attempts);

                    if marker_retries_are_exhausted(attempts) {
                        abandoned_markers += 1;

                        logger::error(
                            "pending_media",
                            format!(
                                "giving up on a pending media marker after {attempts} failed attempts; \
                                 its artifacts are left in the library and are reported by \
                                 Diagnostics as unreferenced files: {error}"
                            ),
                        );
                    } else {
                        logger::warn(
                            "pending_media",
                            format!(
                                "could not reconcile a pending media marker (attempt {attempts} of \
                                 {MAX_MARKER_SWEEP_ATTEMPTS}): {error}"
                            ),
                        );
                    }

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

    // One event for the whole sweep, not one per marker: what the user needs to know is that some
    // artifacts were left behind and where to look, which is one sentence however many there are.
    //
    // Fire and forget, exactly like the integrity event: an emit failure (no window yet - this runs
    // 30 seconds after launch, so there normally is one, but nothing guarantees it) must not affect
    // the sweep, and the `error`-level lines above have already recorded each marker regardless.
    if abandoned_markers > 0 {
        let _ = app.emit(
            crate::constants::EVENT_PENDING_MEDIA_ABANDONED,
            PendingMediaAbandonedEvent {
                abandoned: abandoned_markers,
            },
        );
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
            attempts: 0,
        }
    }

    #[test]
    fn marker_retries_are_exhausted_only_at_the_ceiling() {
        // Both directions, on the exact boundary. Getting this off by one either abandons a marker
        // a launch too early - dropping a record that names files in the user's library - or leaves
        // the forever-retry this exists to end.
        for attempts in 0..MAX_MARKER_SWEEP_ATTEMPTS {
            assert!(
                !marker_retries_are_exhausted(attempts),
                "{attempts} attempts should still be retried"
            );
        }

        assert!(marker_retries_are_exhausted(MAX_MARKER_SWEEP_ATTEMPTS));
        // Past the ceiling stays exhausted: a marker written by a future build with a higher count,
        // or one whose rewrite failed and skipped a number, must not fall back through.
        assert!(marker_retries_are_exhausted(MAX_MARKER_SWEEP_ATTEMPTS + 1));
        assert!(marker_retries_are_exhausted(u32::MAX));
    }

    #[test]
    fn the_attempt_count_survives_a_decode_so_the_budget_is_not_reset_each_launch() {
        // The count only means anything if it is carried across restarts, and sanitize runs on the
        // decode path - so dropping it there would restart the budget on every launch and reinstate
        // the forever-retry with extra steps. The paths still go through the same refusal.
        let decoded = decode_marker(
            r#"{"file_path":"video/media_abc.mp4","thumbnail_path":"../escape.jpg","attempts":3}"#,
        )
        .expect("a marker naming a managed artifact should decode");

        assert_eq!(decoded.attempts, 3);
        assert_eq!(decoded.file_path.as_deref(), Some("video/media_abc.mp4"));
        assert_eq!(decoded.thumbnail_path, None);
    }

    #[test]
    fn a_marker_written_before_the_count_existed_reads_as_a_first_attempt() {
        // Markers from an older build have no `attempts` key at all. Failing to parse those would
        // strand exactly the leftovers the sweep exists to reconcile.
        let decoded = decode_marker(r#"{"file_path":"video/media_abc.mp4"}"#)
            .expect("a marker without the field should still decode");

        assert_eq!(decoded.attempts, 0);
    }

    #[test]
    fn a_recorded_marker_always_starts_its_budget_at_zero() {
        // The count is the sweep's bookkeeping, so a caller must not be able to pre-set it. One that
        // could would hand over a marker abandoned on its first failure, quietly disabling the
        // recovery this module exists for.
        let requested = PendingMediaArtifacts {
            file_path: Some("video/media_abc.mp4".to_string()),
            thumbnail_path: None,
            live_chat_file_path: None,
            attempts: MAX_MARKER_SWEEP_ATTEMPTS + 10,
        };

        let app = mock_app();
        let name = record_pending_media_artifacts(app.handle(), requested).unwrap();

        let marker = pending_media_dir(app.handle()).unwrap().join(&name);
        let decoded = decode_marker(&fs::read_to_string(&marker).unwrap()).unwrap();

        assert_eq!(decoded.attempts, 0);

        clear_pending_media_artifacts(app.handle(), &name).unwrap();
    }

    #[test]
    fn a_failed_attempt_is_written_back_so_the_ceiling_survives_a_restart() {
        // The count only bounds anything if it reaches disk. Nothing above this test would notice if
        // the write-back were dropped or wrote the old value: the sweep's own logging is unobservable,
        // and the marker is only re-read on the *next* launch, so a broken write-back looks exactly
        // like a working one until the retry never ends - which is the bug this whole change removes.
        //
        // The mutation gate found precisely that gap, in both shapes: deleting the call, and dropping
        // the incremented field so the struct update carried the old count through.
        let app = mock_app();
        let name = record_pending_media_artifacts(
            app.handle(),
            artifacts(Some("video/media_abc.mp4"), None, None),
        )
        .unwrap();

        let marker = pending_media_dir(app.handle()).unwrap().join(&name);
        let recorded = decode_marker(&fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(recorded.attempts, 0, "a fresh record starts at zero");

        record_marker_attempt(app.handle(), &name, &recorded, 3);

        let after = decode_marker(&fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(
            after.attempts, 3,
            "the new count must be what lands on disk"
        );
        // The artifacts it names have to survive the rewrite intact - the marker is what tells the
        // next launch which files to reconcile, so losing them would strand exactly the leftover the
        // retry is still trying to clean up.
        assert_eq!(after.file_path.as_deref(), Some("video/media_abc.mp4"));

        clear_pending_media_artifacts(app.handle(), &name).unwrap();
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

    #[tokio::test]
    async fn a_database_that_will_not_open_costs_no_marker_an_attempt() {
        // The failure this branch exists for, and the reason it is a pre-check rather than an error
        // classified inside the loop. A mock app manages no `Db`, so `shared_pool` fails exactly the
        // way it does when the database cannot be opened for real - which is the case the recovery
        // modal is resolving on the very same launch.
        //
        // Both halves are asserted because either alone passes while the bug is live: the marker
        // surviving proves nothing on its own (the sweep leaves a failed marker in place anyway),
        // and the count is what decides whether it is ever offered again. Five launches with an
        // unopenable database used to abandon every pending record in the library, each one naming
        // artifacts still sitting on disk and still reconcilable the moment the database came back.
        let app = mock_app();
        let handle = app.handle();

        let leftover = artifacts(Some("video/media_no_database.mp4"), None, None);
        let name = format!("pending-{}.json", unique_temp_suffix());
        let marker = pending_media_dir(handle).unwrap().join(&name);

        fs::write(&marker, serde_json::to_string(&leftover).unwrap()).unwrap();
        set_modified_before_process_start(&marker);

        let removed = sweep_pending_media_artifacts(handle).await.unwrap();

        assert_eq!(removed, 0, "nothing can be reconciled without the database");
        assert!(
            marker.exists(),
            "a marker must survive a sweep that could not even open the database"
        );

        let after = decode_marker(&fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(
            after.attempts, 0,
            "a database that will not open is not the marker's failure, so it must not spend one \
             of its five attempts"
        );

        clear_pending_media_artifacts(handle, &name).unwrap();
    }

    #[test]
    fn a_marker_that_exhausted_its_retries_is_never_offered_again() {
        // The other half of the ceiling, and the half without which it decides nothing. The sweep
        // reports abandoning a marker, so re-reading one that has already been given up on does not
        // merely waste a cleanup attempt - it puts an error line and a user-facing notice on every
        // launch for the rest of the library's life, which is worse than the unbounded warning the
        // ceiling was added to replace.
        let app = mock_app();
        let handle = app.handle();

        let exhausted = PendingMediaArtifacts {
            attempts: MAX_MARKER_SWEEP_ATTEMPTS,
            ..artifacts(Some("video/media_given_up.mp4"), None, None)
        };
        let name = format!("pending-{}.json", unique_temp_suffix());
        let marker = pending_media_dir(handle).unwrap().join(&name);

        fs::write(&marker, serde_json::to_string(&exhausted).unwrap()).unwrap();
        set_modified_before_process_start(&marker);

        let found = read_pending_markers(handle)
            .unwrap()
            .into_iter()
            .any(|(marker_name, _)| marker_name == name);

        assert!(
            !found,
            "a marker already given up on must not be offered to the sweep again"
        );

        // The file itself stays: it names artifacts in the user's library, and abandoning the record
        // is not the same as being allowed to remove them. Diagnostics is what reports and removes.
        assert!(
            marker.exists(),
            "abandoning the record must not delete the marker"
        );

        clear_pending_media_artifacts(handle, &name).unwrap();
    }

    #[test]
    fn a_marker_one_attempt_short_of_the_ceiling_is_still_offered() {
        // The boundary from the other side, so the filter above cannot be widened into "stop
        // reconciling anything that has ever failed". A marker at one below the ceiling is still a
        // leftover the sweep should try, and the transient case it exists for - a library drive that
        // mounts late - is exactly the one that resolves on a later launch.
        let app = mock_app();
        let handle = app.handle();

        let retrying = PendingMediaArtifacts {
            attempts: MAX_MARKER_SWEEP_ATTEMPTS - 1,
            ..artifacts(Some("video/media_retrying.mp4"), None, None)
        };
        let name = format!("pending-{}.json", unique_temp_suffix());
        let marker = pending_media_dir(handle).unwrap().join(&name);

        fs::write(&marker, serde_json::to_string(&retrying).unwrap()).unwrap();
        set_modified_before_process_start(&marker);

        let found = read_pending_markers(handle)
            .unwrap()
            .into_iter()
            .find(|(marker_name, _)| marker_name == &name);

        assert_eq!(found, Some((name.clone(), retrying)));

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
