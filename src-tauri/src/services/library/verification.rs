//! The deep library check. re-reading every stored artifact and comparing its content against the
//! hash its own filename declares.
//!
//! Separate from `integrity.rs`, which answers a different question. That one asks whether the
//! database and the directory agree (is the file there, is the file referenced), and it answers it
//! from `stat` alone, so it is cheap enough to run whenever Diagnostics is opened. What it called
//! `corrupt` was only a zero-length file, which is the one corruption that shows up in a `stat`.
//!
//! Everything else it could not see. A bad sector inside a 2 GB video, a truncated copy, a
//! cloud-sync placeholder standing in for content that was evicted. All of them keep their size and
//! pass. On an external drive, which is where a large library tends to live, that is the failure
//! that actually happens, and this app exists so a video that has since been removed from YouTube
//! is still watchable years later. A check that reports such a library as healthy is worse than no
//! check, because it is the answer someone acts on.
//!
//! The verification itself needs nothing invented. Every file this app writes is content-addressed
//! (`media_<sha256>.<ext>`, `thumb_<sha256>.<ext>`), so the expected digest is the name. What this
//! costs is reading every byte, which is why it is a separate, user-triggered operation with
//! progress and a cancel rather than part of the check that runs on open.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

use crate::services::logger;
use crate::utils::hash::{file_hash_cancellable, is_cancelled};
use crate::utils::path::{absolute_path_from_relative, ManagedSubtree};
use crate::AppResult;

/// How many example paths of each kind the report carries back, matching `integrity.rs`.
const MAX_EXAMPLES: usize = 5;

/// The prefixes the content-addressed writers use, with the subtree each belongs to.
///
/// `media.rs` writes `media_<hash>.<ext>` under `video/` or `audio/`, and `thumbnail/persist.rs`
/// writes `thumb_<hash>.<ext>` under `thumbnails/`. Live chat replays are deliberately absent. They
/// are named after the yt-dlp output file rather than after their content, so there is no digest in
/// the name to compare against and claiming to have verified them would be a lie.
const CONTENT_ADDRESSED_PREFIXES: [&str; 2] = ["media_", "thumb_"];

/// The hash a content-addressed filename declares, or `None` when the name declares none.
///
/// `None` is a real answer rather than a failure, and keeping the two apart is the whole reason this
/// is a separate function. A library can hold files this app did not name. One written before the
/// content-addressed layout, one restored from a backup by hand, one whose name a sync client
/// mangled. There is nothing to compare those against, so they are reported as unverifiable and
/// counted separately. Treating them as corrupt would make the first honest run of this check
/// accuse the user's own files.
///
/// The digest is validated as a 64-character hex string rather than taken as whatever follows the
/// prefix, so a name like `media_backup.mp4` is unverifiable rather than a comparison against the
/// literal text `backup`.
pub(crate) fn declared_content_hash(file_name: &str) -> Option<&str> {
    let stem = file_name.split('.').next()?;

    let digest = CONTENT_ADDRESSED_PREFIXES
        .iter()
        .find_map(|prefix| stem.strip_prefix(prefix))?;

    let is_sha256 = digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit());

    is_sha256.then_some(digest)
}

/// What one file's verification concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ContentVerification {
    /// The file's content hashes to the digest its name declares.
    Verified,
    /// It does not. The bytes on disk are not the bytes that were stored.
    Corrupt,
    /// The name declares no digest, so there is nothing to check it against.
    Unverifiable,
    /// The file is not there, or could not be read. `integrity.rs` already reports a missing file;
    /// this exists so an unreadable one does not silently count as verified.
    Unreadable,
}

// usize counts are annotated `number` (serialized as JSON numbers, not the bigint ts-rs emits by
// default), matching LibraryIntegrityReport.
#[derive(Serialize, Clone, Debug, Default, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/generated/")]
#[serde(rename_all = "camelCase")]
pub struct ContentVerificationReport {
    #[ts(type = "number")]
    pub checked: usize,
    #[ts(type = "number")]
    pub verified: usize,
    #[ts(type = "number")]
    pub corrupt: usize,
    pub corrupt_examples: Vec<String>,
    #[ts(type = "number")]
    pub unverifiable: usize,
    pub unverifiable_examples: Vec<String>,
    #[ts(type = "number")]
    pub unreadable: usize,
    pub unreadable_examples: Vec<String>,
    /// True when the run stopped early because the user cancelled. The counts above are then a
    /// partial result, and the caller has to say so rather than presenting them as a clean bill of
    /// health, which is the whole reason this flag is on the report instead of being inferred.
    pub cancelled: bool,
}

/// Whether a verification is running, and whether it has been asked to stop.
///
/// Two flags rather than one, because they answer different questions and only one of them is
/// allowed to be sticky. `RUNNING` is what makes this a single-run operation. A second request is
/// refused rather than queued, which matters because the work is bounded only by the size of the
/// library and two concurrent sweeps would read every byte twice while competing for the same
/// disk. `CANCELLED` is the stop signal, and it is reset when a run begins so a cancel left over
/// from a previous run cannot stop the next one before it starts.
static VERIFICATION_RUNNING: AtomicBool = AtomicBool::new(false);
static VERIFICATION_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Held for the length of one verification; releases the single-run slot on drop.
///
/// A guard rather than a matched pair of calls, for the reason every other guard in this crate
/// exists. The run has several exits (a refused library path, a channel that went away, a
/// cancellation, a normal finish) and one of them forgetting to release would leave the feature
/// permanently unavailable until the app restarts, with nothing to point at.
pub(crate) struct VerificationRunGuard;

impl Drop for VerificationRunGuard {
    fn drop(&mut self) {
        VERIFICATION_RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Claims the single verification slot, or `None` when one is already running.
pub(crate) fn try_begin_verification() -> Option<VerificationRunGuard> {
    VERIFICATION_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()?;

    // Reset *after* the slot is claimed, so this cannot clear a flag the run that owns it is about
    // to read.
    VERIFICATION_CANCELLED.store(false, Ordering::SeqCst);

    Some(VerificationRunGuard)
}

/// Asks the running verification to stop. A no-op when none is running. The flag is reset by the
/// next run that begins, so a stray cancel cannot stop it.
pub fn request_verification_cancel() {
    VERIFICATION_CANCELLED.store(true, Ordering::SeqCst);
}

/// The flag the sweep checks. `'static`, so it can be handed to the blocking pool without cloning.
pub(crate) fn verification_cancel_flag() -> &'static AtomicBool {
    &VERIFICATION_CANCELLED
}

/// How a verification reports back to the frontend. A run of `progress` events, then one `done`
/// carrying the report. Same shape and same reason as `LiveChatStreamEvent`. The frontend resolves
/// on `done` rather than on the command returning, because channel messages and the invoke response
/// travel independently.
#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum ContentVerificationEvent {
    Progress {
        #[ts(type = "number")]
        checked: usize,
        #[ts(type = "number")]
        total: usize,
    },
    Done {
        report: ContentVerificationReport,
    },
}

/// Verifies one stored artifact against the digest in its name.
///
/// `relative_path` is confined to `subtree` by `absolute_path_from_relative` before anything is
/// opened, so this cannot be pointed outside the managed layout even by a hand-edited row. A path
/// that fails that confinement is `Unverifiable` rather than an error. It is a row `integrity.rs`
/// already reports as invalid, and failing the whole sweep over one bad row would be the wrong
/// trade for a check whose value is covering everything else.
pub(crate) fn verify_stored_file(
    library_dir: &Path,
    relative_path: &str,
    subtree: ManagedSubtree,
    cancel: Option<&AtomicBool>,
) -> ContentVerification {
    let Ok(absolute) = absolute_path_from_relative(library_dir, relative_path, subtree) else {
        return ContentVerification::Unverifiable;
    };

    let Some(file_name) = absolute.file_name().and_then(|name| name.to_str()) else {
        return ContentVerification::Unverifiable;
    };

    let Some(expected) = declared_content_hash(file_name) else {
        return ContentVerification::Unverifiable;
    };

    // The confinement above is lexical, and every directory walk in this family refuses a symlink
    // rather than following it. A row naming one planted under `video/` would otherwise have its
    // target hashed and reported on (Verified, even, if the target happened to match) as though it
    // were the library's file. Unverifiable, like a path that fails confinement. This is not a
    // corrupt artifact, it is not an artifact of this app at all.
    if crate::services::filesystem::path_is_symlink(&absolute) {
        return ContentVerification::Unverifiable;
    }

    match file_hash_cancellable(&absolute, cancel) {
        // A cancelled hash reports an error, and it must not be read as corruption. The caller
        // checks the flag itself before recording anything, so this only has to avoid the Corrupt
        // answer; Unreadable is the honest one for a digest that was never computed.
        Ok(actual) => {
            if actual.eq_ignore_ascii_case(expected) {
                ContentVerification::Verified
            } else {
                ContentVerification::Corrupt
            }
        }
        Err(_) => ContentVerification::Unreadable,
    }
}

/// One artifact to verify, with its stored path and which subtree it lives in.
pub(crate) struct VerifiableArtifact {
    pub(crate) relative_path: String,
    pub(crate) subtree: ManagedSubtree,
}

/// Records an outcome against the running report, keeping up to [`MAX_EXAMPLES`] paths per kind.
fn record(report: &mut ContentVerificationReport, path: &str, outcome: ContentVerification) {
    report.checked += 1;

    let examples = match outcome {
        ContentVerification::Verified => {
            report.verified += 1;
            return;
        }
        ContentVerification::Corrupt => {
            report.corrupt += 1;
            &mut report.corrupt_examples
        }
        ContentVerification::Unverifiable => {
            report.unverifiable += 1;
            &mut report.unverifiable_examples
        }
        ContentVerification::Unreadable => {
            report.unreadable += 1;
            &mut report.unreadable_examples
        }
    };

    if examples.len() < MAX_EXAMPLES {
        examples.push(path.to_string());
    }
}

/// Verifies every artifact in `artifacts`, reporting progress through `on_progress` as it goes.
///
/// The cancel flag is checked before each file rather than only between batches, because one file
/// can be several gigabytes. A check that only looked between files would leave Cancel unresponsive
/// for exactly as long as the slowest item takes, which on the libraries this is written for is
/// minutes. `file_hash_cancellable` carries the same flag into the read loop, so a cancel lands
/// inside a large file too.
///
/// `on_progress` is called with (checked so far, total). Its failure stops the run. The only caller
/// emits on an IPC channel, and a channel that has gone away means the window that asked is gone.
pub(crate) fn verify_library_content_sync<F>(
    library_dir: &Path,
    artifacts: &[VerifiableArtifact],
    cancel: Option<&AtomicBool>,
    mut on_progress: F,
) -> AppResult<ContentVerificationReport>
where
    F: FnMut(usize, usize) -> AppResult<()>,
{
    let mut report = ContentVerificationReport::default();
    let total = artifacts.len();

    for artifact in artifacts {
        if is_cancelled(cancel) {
            report.cancelled = true;
            break;
        }

        let outcome = verify_stored_file(
            library_dir,
            &artifact.relative_path,
            artifact.subtree,
            cancel,
        );

        // Re-checked after the hash rather than only before it. A cancel that landed mid-read comes
        // back as Unreadable, and recording that would leave a cancelled run reporting unreadable
        // files it never actually failed to read.
        if is_cancelled(cancel) {
            report.cancelled = true;
            break;
        }

        record(&mut report, &artifact.relative_path, outcome);
        on_progress(report.checked, total)?;
    }

    if report.corrupt > 0 {
        logger::warn(
            "library_verification",
            format!(
                "content verification found {} file(s) whose bytes do not match the hash in their name",
                report.corrupt
            ),
        );
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{LIBRARY_DIR_THUMBNAILS, LIBRARY_DIR_VIDEO};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    /// The sha256 of `b"media bytes"`, so a fixture can be given its real content-addressed name
    /// rather than a made-up one that would make every assertion here vacuous.
    fn hash_of(content: &[u8]) -> String {
        let dir = unique_dir("hash");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("probe.bin");
        fs::write(&file, content).unwrap();

        let hash = crate::utils::hash::file_hash(&file).unwrap();
        let _ = fs::remove_dir_all(&dir);

        hash
    }

    fn unique_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-verify-{label}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    /// A library holding one video whose name declares the hash of its own content.
    fn library_with_media(label: &str, content: &[u8]) -> (PathBuf, String) {
        let library = unique_dir(label);
        fs::create_dir_all(library.join(LIBRARY_DIR_VIDEO)).unwrap();

        let relative = format!("{LIBRARY_DIR_VIDEO}/media_{}.mp4", hash_of(content));
        fs::write(library.join(&relative), content).unwrap();

        (library, relative)
    }

    fn media(relative_path: &str) -> VerifiableArtifact {
        VerifiableArtifact {
            relative_path: relative_path.to_string(),
            subtree: ManagedSubtree::Media,
        }
    }

    #[test]
    fn a_content_addressed_name_declares_its_digest() {
        let digest = "a".repeat(64);

        assert_eq!(
            declared_content_hash(&format!("media_{digest}.mp4")),
            Some(digest.as_str())
        );
        assert_eq!(
            declared_content_hash(&format!("thumb_{digest}.jpg")),
            Some(digest.as_str())
        );
        // The compressed live-chat name carries two extensions; the split on the first dot is what
        // keeps the stem intact for the names that do declare a digest.
        assert_eq!(
            declared_content_hash(&format!("media_{digest}.json.gz")),
            Some(digest.as_str())
        );
    }

    #[test]
    fn a_name_that_declares_no_digest_is_not_read_as_one() {
        // Each of these is a file a library can legitimately hold, and calling any of them corrupt
        // would make the first honest run of this check accuse the user's own files.
        for name in [
            "media_backup.mp4",                        // the prefix, but not a digest
            "holiday.mp4",                             // no prefix at all
            "media_.mp4",                              // empty digest
            &format!("media_{}.mp4", "a".repeat(63)),  // one character short
            &format!("media_{}.mp4", "a".repeat(65)),  // one character long
            &format!("media_{}.mp4", "g".repeat(64)),  // right length, not hex
            &format!("avatar_{}.jpg", "a".repeat(64)), // a prefix this app does not content-address
        ] {
            assert_eq!(
                declared_content_hash(name),
                None,
                "must not read a digest out of: {name}"
            );
        }
    }

    #[test]
    fn a_file_matching_its_name_verifies() {
        let (library, relative) = library_with_media("ok", b"media bytes");

        assert_eq!(
            verify_stored_file(&library, &relative, ManagedSubtree::Media, None),
            ContentVerification::Verified
        );

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_under_a_managed_directory_is_unverifiable_not_read() {
        use std::os::unix::fs::symlink;

        // The target matches the digest in the link's name, so following the link would report
        // Verified, which is exactly the answer a planted link must not get. It would vouch for
        // bytes that live outside the library as if they were the artifact the row names.
        let content = b"media bytes";
        let library = unique_dir("symlink");
        let outside = unique_dir("symlink-outside");
        fs::create_dir_all(library.join(LIBRARY_DIR_VIDEO)).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let target = outside.join("real.mp4");
        fs::write(&target, content).unwrap();

        let relative = format!("{LIBRARY_DIR_VIDEO}/media_{}.mp4", hash_of(content));
        symlink(&target, library.join(&relative)).unwrap();

        assert_eq!(
            verify_stored_file(&library, &relative, ManagedSubtree::Media, None),
            ContentVerification::Unverifiable
        );

        let _ = fs::remove_dir_all(&library);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn a_file_whose_bytes_changed_under_its_name_is_corrupt() {
        // The failure this whole module exists for, and the one the cheap check cannot see. The
        // file is present and its size is unchanged, so `stat` reports nothing wrong.
        let (library, relative) = library_with_media("corrupt", b"media bytes");
        let absolute = library.join(&relative);

        let original = fs::metadata(&absolute).unwrap().len();
        fs::write(&absolute, b"media bytez").unwrap();
        assert_eq!(
            fs::metadata(&absolute).unwrap().len(),
            original,
            "the point is that the size is unchanged, or this asserts nothing"
        );

        assert_eq!(
            verify_stored_file(&library, &relative, ManagedSubtree::Media, None),
            ContentVerification::Corrupt
        );

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn a_zero_length_file_is_corrupt_rather_than_merely_present() {
        // The one case the cheap check already catches, asserted here too. This check must not be
        // weaker than the one it supplements.
        let (library, relative) = library_with_media("hollow", b"media bytes");
        fs::write(library.join(&relative), b"").unwrap();

        assert_eq!(
            verify_stored_file(&library, &relative, ManagedSubtree::Media, None),
            ContentVerification::Corrupt
        );

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn a_missing_file_is_unreadable_rather_than_corrupt() {
        let (library, relative) = library_with_media("gone", b"media bytes");
        fs::remove_file(library.join(&relative)).unwrap();

        assert_eq!(
            verify_stored_file(&library, &relative, ManagedSubtree::Media, None),
            ContentVerification::Unreadable
        );

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn a_path_outside_the_subtree_is_refused_before_anything_is_opened() {
        // The same confinement every other caller-supplied relative path gets. A row naming a
        // thumbnail cannot be verified through the media subtree, and a traversal is refused
        // outright.
        let (library, _) = library_with_media("scope", b"media bytes");

        for path in [
            "thumbnails/thumb_abc.jpg",
            "../outside.mp4",
            "contract.docx",
        ] {
            assert_eq!(
                verify_stored_file(&library, path, ManagedSubtree::Media, None),
                ContentVerification::Unverifiable,
                "must refuse: {path}"
            );
        }

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn a_sweep_counts_each_outcome_and_reports_progress() {
        let library = unique_dir("sweep");
        fs::create_dir_all(library.join(LIBRARY_DIR_VIDEO)).unwrap();
        fs::create_dir_all(library.join(LIBRARY_DIR_THUMBNAILS)).unwrap();

        let good = format!("{LIBRARY_DIR_VIDEO}/media_{}.mp4", hash_of(b"good"));
        fs::write(library.join(&good), b"good").unwrap();

        let bad = format!("{LIBRARY_DIR_VIDEO}/media_{}.mp4", hash_of(b"was good"));
        fs::write(library.join(&bad), b"now bad!").unwrap();

        let unnamed = format!("{LIBRARY_DIR_VIDEO}/media_legacy.mp4");
        fs::write(library.join(&unnamed), b"legacy").unwrap();

        let missing = format!("{LIBRARY_DIR_VIDEO}/media_{}.mp4", hash_of(b"absent"));

        let artifacts = [media(&good), media(&bad), media(&unnamed), media(&missing)];

        let mut progress = Vec::new();
        let report = verify_library_content_sync(&library, &artifacts, None, |checked, total| {
            progress.push((checked, total));
            Ok(())
        })
        .unwrap();

        assert_eq!(report.checked, 4);
        assert_eq!(report.verified, 1);
        assert_eq!(report.corrupt, 1);
        assert_eq!(report.corrupt_examples, vec![bad]);
        assert_eq!(report.unverifiable, 1);
        assert_eq!(report.unverifiable_examples, vec![unnamed]);
        assert_eq!(report.unreadable, 1);
        assert_eq!(report.unreadable_examples, vec![missing]);
        assert!(!report.cancelled);

        // One progress call per file, each carrying the same total, so the caller can render a
        // fraction without being told the denominator separately.
        assert_eq!(progress, vec![(1, 4), (2, 4), (3, 4), (4, 4)]);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn a_cancelled_sweep_stops_and_says_it_was_partial() {
        // The flag is what keeps a partial run from being read as a clean bill of health, which is
        // the one way this check could do harm. Reporting "no problems" over files it never opened.
        let (library, relative) = library_with_media("cancel", b"media bytes");
        let artifacts = [media(&relative), media(&relative), media(&relative)];

        let cancel = AtomicBool::new(false);
        let report =
            verify_library_content_sync(&library, &artifacts, Some(&cancel), |checked, _| {
                // Cancel after the first file, the way the user's click arrives mid-sweep.
                if checked == 1 {
                    cancel.store(true, Ordering::SeqCst);
                }
                Ok(())
            })
            .unwrap();

        assert!(report.cancelled, "a stopped run must report itself partial");
        assert_eq!(
            report.checked, 1,
            "it must stop rather than finish the list"
        );

        let _ = fs::remove_dir_all(&library);
    }

    /// Serializes the three tests below, which read and write the process-global run/cancel flags.
    ///
    /// Without it they race each other rather than the code under test: `cargo test` runs the suite
    /// multithreaded, so the one holding the single slot makes the one asserting the slot is free
    /// fail, intermittently and for a reason that has nothing to do with either property. The
    /// poisoned guard is recovered because a panic in one of them is a real failure being reported,
    /// not a reason to turn the next two into a second, misleading failure.
    fn verification_state_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn a_second_verification_is_refused_rather_than_queued() {
        let _serialized = verification_state_lock();
        // The bound that matters for this operation. The work is proportional to the size of the
        // library, so two concurrent sweeps would read every byte twice while competing for the
        // same disk. A refusal the caller can report ("one is already running") beats a queue the
        // user cannot see.
        let held = try_begin_verification().expect("the first caller must get the slot");

        assert!(
            try_begin_verification().is_none(),
            "a second run must be refused while one is in flight"
        );

        drop(held);

        let after = try_begin_verification().expect("the slot must be released on drop");
        drop(after);
    }

    #[test]
    fn beginning_a_run_clears_a_cancel_left_over_from_the_previous_one() {
        let _serialized = verification_state_lock();
        // Without the reset, cancelling one run would stop the *next* one before it read a single
        // file, and the report would come back empty and cancelled with nothing explaining why.
        request_verification_cancel();
        assert!(verification_cancel_flag().load(Ordering::SeqCst));

        let guard = try_begin_verification().expect("the slot must be free");

        assert!(
            !verification_cancel_flag().load(Ordering::SeqCst),
            "a run must start with a clear cancel flag"
        );

        drop(guard);
    }

    #[test]
    fn cancelling_during_a_run_is_what_the_sweep_reads() {
        let _serialized = verification_state_lock();
        let guard = try_begin_verification().expect("the slot must be free");

        request_verification_cancel();
        assert!(verification_cancel_flag().load(Ordering::SeqCst));

        drop(guard);
        // Left set on purpose. The flag is cleared by the next run that begins, not by the end of
        // this one, which is what keeps the reset in one place.
        assert!(verification_cancel_flag().load(Ordering::SeqCst));

        // Restore the shared state for whichever test runs next in this process.
        let restore = try_begin_verification().expect("the slot must be free");
        drop(restore);
    }

    #[test]
    fn an_empty_library_verifies_without_claiming_anything() {
        let library = unique_dir("empty");
        fs::create_dir_all(&library).unwrap();

        let report = verify_library_content_sync(&library, &[], None, |_, _| Ok(())).unwrap();

        assert_eq!(report.checked, 0);
        assert_eq!(report.corrupt, 0);
        assert!(!report.cancelled);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn every_example_list_is_capped_while_its_count_stays_complete() {
        // `record` is the one place the report grows, and it does two things that fail in opposite
        // directions. It counts every outcome, and it keeps a bounded sample of the paths. A cap
        // that reached the count would under-report corruption to the user; a cap missing from the
        // list would put every corrupt path in a library-sized report onto the IPC boundary.
        //
        // Driven through `record` rather than through a sweep because the cap is its decision and a
        // sweep would need MAX_EXAMPLES + 1 real files per category to reach it. The three
        // list-keeping outcomes are covered together since they share the one guard; `Verified`
        // returns before it and is asserted separately below.
        let over_cap = MAX_EXAMPLES + 1;

        for outcome in [
            ContentVerification::Corrupt,
            ContentVerification::Unverifiable,
            ContentVerification::Unreadable,
        ] {
            let mut report = ContentVerificationReport::default();

            for index in 0..over_cap {
                record(&mut report, &format!("video/media_{index}.mp4"), outcome);
            }

            let (count, examples) = match outcome {
                ContentVerification::Corrupt => (report.corrupt, &report.corrupt_examples),
                ContentVerification::Unverifiable => {
                    (report.unverifiable, &report.unverifiable_examples)
                }
                ContentVerification::Unreadable => (report.unreadable, &report.unreadable_examples),
                ContentVerification::Verified => unreachable!("not one of the three above"),
            };

            assert_eq!(report.checked, over_cap, "{outcome:?} counts every file");
            assert_eq!(
                count, over_cap,
                "{outcome:?} counts every file in its category"
            );
            // Exactly the cap, not merely "at most". `<=` in the guard keeps one more than the
            // constant says, which is the off-by-one neither count above can reveal.
            assert_eq!(
                examples.len(),
                MAX_EXAMPLES,
                "{outcome:?} caps its examples"
            );
        }
    }

    #[test]
    fn a_verified_file_is_counted_without_being_kept_as_an_example() {
        // The early return in `record`. A clean library is the common case, so keeping a sample of
        // it would be a list the dialog never shows, and `checked` plus `verified` already say
        // everything there is to say about it.
        let mut report = ContentVerificationReport::default();

        for index in 0..(MAX_EXAMPLES + 1) {
            record(
                &mut report,
                &format!("video/media_{index}.mp4"),
                ContentVerification::Verified,
            );
        }

        assert_eq!(report.checked, MAX_EXAMPLES + 1);
        assert_eq!(report.verified, MAX_EXAMPLES + 1);
        assert!(report.corrupt_examples.is_empty());
        assert!(report.unverifiable_examples.is_empty());
        assert!(report.unreadable_examples.is_empty());
    }
}
