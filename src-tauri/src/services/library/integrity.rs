use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::services::filesystem::dir_entry_is_symlink;
use crate::services::logger;
use crate::services::video_repository::MediaIntegrityReference;
use crate::AppResult;

/// How many example paths the report carries per category (missing, corrupt, invalid, orphan).
///
/// The counts in the report are complete; these are the sample the dialog shows next to each one.
/// The cap is what keeps the report a fixed size: a library with fifty thousand orphans would
/// otherwise send fifty thousand strings over IPC to fill a list nobody scrolls.
///
/// Named rather than spelled `5` at each of the four sites, which is what it was. Not because four
/// literals are untidy, but because nothing named the invariant they share, so a mutation run
/// reported all four as separate survivors and an edit to any one of them would read as deliberate.
///
/// `verification.rs` declares its own constant of the same value, and the duplication is the
/// intended shape rather than a missed extraction: the two cap different reports, so either could
/// move without the other, while the value is deliberately kept equal so the two Diagnostics
/// sections show samples of the same size. Sharing one constant would make that agreement a
/// constraint instead of a choice.
const MAX_EXAMPLES: usize = 5;

// usize counts are annotated `number` (serialized as JSON numbers, not the bigint ts-rs
// emits by default).
#[derive(Serialize, Clone, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct LibraryIntegrityReport {
    #[ts(type = "number")]
    pub checked_media_files: usize,
    #[ts(type = "number")]
    pub missing_media_files: usize,
    pub missing_media_examples: Vec<String>,
    #[ts(type = "number")]
    pub corrupt_media_files: usize,
    pub corrupt_media_examples: Vec<String>,
    #[ts(type = "number")]
    pub checked_thumbnail_files: usize,
    #[ts(type = "number")]
    pub missing_thumbnail_files: usize,
    pub missing_thumbnail_examples: Vec<String>,
    #[ts(type = "number")]
    pub corrupt_thumbnail_files: usize,
    pub corrupt_thumbnail_examples: Vec<String>,
    #[ts(type = "number")]
    pub orphan_media_files: usize,
    pub orphan_media_examples: Vec<String>,
    #[ts(type = "number")]
    pub orphan_thumbnail_files: usize,
    pub orphan_thumbnail_examples: Vec<String>,
    #[ts(type = "number")]
    pub invalid_media_files: usize,
    pub invalid_media_examples: Vec<String>,
    #[ts(type = "number")]
    pub invalid_thumbnail_files: usize,
    pub invalid_thumbnail_examples: Vec<String>,
    #[ts(type = "number")]
    pub checked_live_chat_files: usize,
    #[ts(type = "number")]
    pub missing_live_chat_files: usize,
    pub missing_live_chat_examples: Vec<String>,
    #[ts(type = "number")]
    pub corrupt_live_chat_files: usize,
    pub corrupt_live_chat_examples: Vec<String>,
    #[ts(type = "number")]
    pub orphan_live_chat_files: usize,
    pub orphan_live_chat_examples: Vec<String>,
    #[ts(type = "number")]
    pub invalid_live_chat_files: usize,
    pub invalid_live_chat_examples: Vec<String>,
}

/// The media row a reported path belongs to, so Diagnostics can turn a "missing media" example
/// into a jump-to-the-media action.
///
/// camelCase on the wire because the frontend consumed a hand-written type of this shape long
/// before the resolution moved here; exporting it means the two can no longer drift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct DiagnosticsMediaTarget {
    #[ts(type = "number")]
    pub channel_id: i64,
    #[ts(type = "number")]
    pub media_id: i64,
}

/// What the integrity command answers with: the disk-versus-database report, plus the media row
/// behind each *reported* path.
///
/// The two are returned together rather than as two commands because they are one question asked
/// of one snapshot of the database. Resolving the targets here is also what keeps this cheap: the
/// report caps every example list at five entries, so the map holds at most a handful of rows no
/// matter how large the library is. The renderer used to build it by pulling every media row over
/// IPC and sending three arrays of every stored path back, which made an operation whose output is
/// bounded cost time proportional to the whole library, twice.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub struct LibraryIntegrityCheck {
    pub report: LibraryIntegrityReport,
    /// Keyed by the stored path exactly as it appears in the report's example lists, so a lookup
    /// is a plain index rather than a re-normalization the two sides could spell differently.
    pub media_targets: HashMap<String, DiagnosticsMediaTarget>,
}

/// The stored paths the database expects to find on disk, split by artifact kind.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ExpectedLibraryPaths {
    pub(crate) media: Vec<String>,
    pub(crate) thumbnails: Vec<String>,
    pub(crate) live_chat: Vec<String>,
}

/// Collects what the database expects the library to hold, from the media rows and the channel
/// avatars.
///
/// Pure, and separate from the check, because the one decision in it has a user-visible cost and
/// no I/O: the avatars belong in the *thumbnail* set. They live under `thumbnails/` but are
/// referenced by the channels table, so dropping them here turns every avatar that is not also a
/// media thumbnail into a reported orphan. A file Diagnostics then invites the user to delete
/// while the app is still drawing it in the sidebar.
pub(crate) fn expected_library_paths(
    references: &[MediaIntegrityReference],
    avatar_paths: Vec<String>,
) -> ExpectedLibraryPaths {
    ExpectedLibraryPaths {
        media: references
            .iter()
            .map(|reference| reference.file_path.clone())
            .collect(),
        thumbnails: references
            .iter()
            .filter_map(|reference| reference.thumbnail_path.clone())
            .chain(avatar_paths)
            .collect(),
        live_chat: references
            .iter()
            .filter_map(|reference| reference.live_chat_file_path.clone())
            .collect(),
    }
}

/// Normalizes a stored path to the form the report echoes back, so a target can be looked up by
/// the exact string the example list carries.
fn normalize_path_key(path: &str) -> String {
    path.trim().replace('\\', "/")
}

/// Builds the target map for the paths the report actually named.
///
/// Only the media examples are resolved, and only the two categories the UI offers a jump for: a
/// missing or corrupt media file still has its row, so it can be opened in the library. An orphan
/// has no row by definition, and a thumbnail or live chat path is not something to navigate to.
///
/// Pure, and extracted, because the alternative (resolving every reference) is what this change
/// exists to stop, and the failure mode of getting the key wrong is silent: the path renders
/// without a jump action and nothing reports why.
pub(crate) fn media_targets_for_report(
    report: &LibraryIntegrityReport,
    references: &[MediaIntegrityReference],
) -> HashMap<String, DiagnosticsMediaTarget> {
    let reported: HashSet<String> = report
        .missing_media_examples
        .iter()
        .chain(report.corrupt_media_examples.iter())
        .map(|path| normalize_path_key(path))
        .filter(|path| !path.is_empty())
        .collect();

    if reported.is_empty() {
        return HashMap::new();
    }

    let mut targets = HashMap::new();

    for reference in references {
        let key = normalize_path_key(&reference.file_path);

        if !reported.contains(&key) {
            continue;
        }

        targets.insert(
            key,
            DiagnosticsMediaTarget {
                channel_id: reference.channel_id,
                media_id: reference.id,
            },
        );
    }

    targets
}

/// Outcome of checking one set of stored paths against the library on disk.
struct PathCheckOutcome {
    checked: usize,
    missing: usize,
    missing_examples: Vec<String>,
    /// Files that exist inside the library but are zero-length, i.e. present-but-corrupted
    /// (a truncated copy, external-disk corruption). Counted separately from `missing` so the
    /// diagnostics do not report a hollow file as healthy just because it is on disk.
    corrupt: usize,
    corrupt_examples: Vec<String>,
    /// Stored paths that are neither checked nor missing because they are malformed for a
    /// library-relative reference: absolute, or escaping via `..`, or resolving outside the
    /// library. The database is supposed to only hold managed relative paths, so these are a
    /// real anomaly (corruption, legacy data, tampering) and are surfaced rather than dropped.
    invalid: usize,
    invalid_examples: Vec<String>,
}

fn resolve_stored_path(library_path: &Path, stored_path: &str) -> PathBuf {
    let candidate = PathBuf::from(stored_path);

    if candidate.is_absolute() {
        return candidate;
    }

    library_path.join(candidate)
}

fn collect_missing_paths(library_path: &Path, stored_paths: Vec<String>) -> PathCheckOutcome {
    let canonical_library = library_path
        .canonicalize()
        .unwrap_or_else(|_| library_path.to_path_buf());

    let mut unique_paths = HashSet::new();

    for item in stored_paths {
        let trimmed = item.trim();

        if trimmed.is_empty() {
            continue;
        }

        unique_paths.insert(trimmed.to_string());
    }

    let mut outcome = PathCheckOutcome {
        checked: 0,
        missing: 0,
        missing_examples: Vec::new(),
        corrupt: 0,
        corrupt_examples: Vec::new(),
        invalid: 0,
        invalid_examples: Vec::new(),
    };

    for stored_path in unique_paths {
        let candidate = PathBuf::from(&stored_path);

        // A stored reference is expected to be a managed relative path. A `..` traversal or a
        // path that resolves outside the library is malformed (corruption, legacy or tampered
        // data): count it as an anomaly so the diagnostics surface it instead of hiding it.
        let escapes_via_parent = candidate.components().any(|c| c == Component::ParentDir);
        let resolved_path = resolve_stored_path(&canonical_library, &stored_path);
        let resolves_outside = !resolved_path.starts_with(&canonical_library);

        if escapes_via_parent || resolves_outside {
            outcome.invalid += 1;

            if outcome.invalid_examples.len() < MAX_EXAMPLES {
                outcome.invalid_examples.push(stored_path);
            }

            continue;
        }

        outcome.checked += 1;

        // canonicalize resolves symlinks. Re-check containment on the real path.
        // if the path doesn't exist, canonicalize fails and we treat it as missing.
        let exists_within_library = resolved_path
            .canonicalize()
            .map(|canonical| canonical.starts_with(&canonical_library))
            .unwrap_or(false);

        if !exists_within_library {
            outcome.missing += 1;

            if outcome.missing_examples.len() < MAX_EXAMPLES {
                outcome.missing_examples.push(stored_path);
            }

            continue;
        }

        // Present on disk, but a zero-length file is a truncated/corrupted artifact (a bad copy,
        // an interrupted write, external-disk corruption) rather than a healthy one. Surface it
        // distinctly so a hollow file is not reported as fine just because it exists.
        let is_zero_length = fs::metadata(&resolved_path)
            .map(|meta| meta.len() == 0)
            .unwrap_or(false);

        if is_zero_length {
            outcome.corrupt += 1;

            if outcome.corrupt_examples.len() < MAX_EXAMPLES {
                outcome.corrupt_examples.push(stored_path);
            }
        }
    }

    outcome
}

/// Builds the set of paths the database expects to exist, normalized to forward slashes so it
/// can be compared against files discovered on disk.
fn build_expected_set(stored_paths: &[String]) -> HashSet<String> {
    stored_paths
        .iter()
        .map(|path| path.trim().replace('\\', "/"))
        .filter(|path| !path.is_empty())
        .collect()
}

/// Lists every file under `dir` as a path relative to `root`, using forward slashes.
fn list_files_relative(dir: &Path, root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };

        for entry in entries.flatten() {
            // Skip symlinks without following them: a symlinked directory pointing at an ancestor
            // would push its own subtree back onto the stack forever (a DoS reachable through
            // check_library_integrity). The library never creates symlinks of its own.
            if dir_entry_is_symlink(&entry) {
                continue;
            }

            let path = entry.path();

            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }

    files
}

/// Finds files inside `subdirs` of the library that no database record references. Since the
/// library folder is fully owned by the app (media is copied/moved in), any such file is a
/// leftover taking up disk space.
fn collect_orphan_paths(
    library_root: &Path,
    subdirs: &[&str],
    expected: &HashSet<String>,
) -> (usize, Vec<String>) {
    let mut orphan_count = 0usize;
    let mut orphan_examples: Vec<String> = Vec::new();

    for subdir in subdirs {
        for relative in list_files_relative(&library_root.join(subdir), library_root) {
            if expected.contains(&relative) {
                continue;
            }

            orphan_count += 1;

            if orphan_examples.len() < MAX_EXAMPLES {
                orphan_examples.push(relative);
            }
        }
    }

    (orphan_count, orphan_examples)
}

/// Compares the database's media/thumbnail path records against what actually exists on disk,
/// reporting files the database references but that are missing, and files on disk that no
/// database record references (orphans).
pub fn check_library_integrity_sync(
    library_path: &str,
    media_paths: Vec<String>,
    thumbnail_paths: Vec<String>,
    live_chat_paths: Vec<String>,
) -> AppResult<LibraryIntegrityReport> {
    let raw_root = PathBuf::from(library_path);
    let library_root = raw_root.canonicalize().unwrap_or(raw_root);

    logger::info(
        "library_integrity",
        format!(
            "checking integrity for library='{}', media_paths={}, thumbnail_paths={}, live_chat_paths={}",
            logger::redact_path(&library_root),
            media_paths.len(),
            thumbnail_paths.len(),
            live_chat_paths.len()
        ),
    );

    let media_expected = build_expected_set(&media_paths);
    let thumbnail_expected = build_expected_set(&thumbnail_paths);
    let live_chat_expected = build_expected_set(&live_chat_paths);

    let media = collect_missing_paths(&library_root, media_paths);
    let thumbnail = collect_missing_paths(&library_root, thumbnail_paths);
    let live_chat = collect_missing_paths(&library_root, live_chat_paths);

    let (orphan_media_files, orphan_media_examples) =
        collect_orphan_paths(&library_root, &["video", "audio"], &media_expected);

    let (orphan_thumbnail_files, orphan_thumbnail_examples) =
        collect_orphan_paths(&library_root, &["thumbnails"], &thumbnail_expected);

    let (orphan_live_chat_files, orphan_live_chat_examples) =
        collect_orphan_paths(&library_root, &["live_chat"], &live_chat_expected);

    Ok(LibraryIntegrityReport {
        checked_media_files: media.checked,
        missing_media_files: media.missing,
        missing_media_examples: media.missing_examples,
        corrupt_media_files: media.corrupt,
        corrupt_media_examples: media.corrupt_examples,
        checked_thumbnail_files: thumbnail.checked,
        missing_thumbnail_files: thumbnail.missing,
        missing_thumbnail_examples: thumbnail.missing_examples,
        corrupt_thumbnail_files: thumbnail.corrupt,
        corrupt_thumbnail_examples: thumbnail.corrupt_examples,
        orphan_media_files,
        orphan_media_examples,
        orphan_thumbnail_files,
        orphan_thumbnail_examples,
        invalid_media_files: media.invalid,
        invalid_media_examples: media.invalid_examples,
        invalid_thumbnail_files: thumbnail.invalid,
        invalid_thumbnail_examples: thumbnail.invalid_examples,
        checked_live_chat_files: live_chat.checked,
        missing_live_chat_files: live_chat.missing,
        missing_live_chat_examples: live_chat.missing_examples,
        corrupt_live_chat_files: live_chat.corrupt,
        corrupt_live_chat_examples: live_chat.corrupt_examples,
        orphan_live_chat_files,
        orphan_live_chat_examples,
        invalid_live_chat_files: live_chat.invalid,
        invalid_live_chat_examples: live_chat.invalid_examples,
    })
}

/// Runs the integrity check against what the database currently references, and resolves the
/// media row behind each path the report ended up naming.
///
/// This is what the command calls. `check_library_integrity_sync` above stays the pure
/// paths-versus-disk comparison it has always been (every one of its tests still drives it
/// directly), and this only supplies its inputs from the rows and folds the targets in.
///
/// Blocking (it walks the library), so the caller runs it off the async runtime; the database read
/// happens before that, on the caller's side, because it is async.
pub fn check_library_integrity_for_references(
    library_path: &str,
    references: Vec<MediaIntegrityReference>,
    avatar_paths: Vec<String>,
) -> AppResult<LibraryIntegrityCheck> {
    let expected = expected_library_paths(&references, avatar_paths);

    let report = check_library_integrity_sync(
        library_path,
        expected.media,
        expected.thumbnails,
        expected.live_chat,
    )?;

    let media_targets = media_targets_for_report(&report, &references);

    Ok(LibraryIntegrityCheck {
        report,
        media_targets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kavynex-integrity-test-{prefix}-{}",
            crate::utils::naming::unique_temp_suffix()
        ))
    }

    fn reference(
        id: i64,
        channel_id: i64,
        file_path: &str,
        thumbnail_path: Option<&str>,
        live_chat_file_path: Option<&str>,
    ) -> MediaIntegrityReference {
        MediaIntegrityReference {
            id,
            channel_id,
            title: format!("Media {id}"),
            file_path: file_path.to_string(),
            thumbnail_path: thumbnail_path.map(str::to_string),
            live_chat_file_path: live_chat_file_path.map(str::to_string),
        }
    }

    #[test]
    fn expected_paths_split_the_rows_by_artifact_kind() {
        let references = vec![
            reference(
                1,
                10,
                "video/a.mp4",
                Some("thumbnails/a.jpg"),
                Some("live_chat/a.json.gz"),
            ),
            reference(2, 10, "audio/b.m4a", None, None),
        ];

        let expected = expected_library_paths(&references, Vec::new());

        assert_eq!(expected.media, vec!["video/a.mp4", "audio/b.m4a"]);
        // A row with no thumbnail or replay contributes nothing to those sets rather than an
        // empty string, which would land in the expected set and match nothing on disk.
        assert_eq!(expected.thumbnails, vec!["thumbnails/a.jpg"]);
        assert_eq!(expected.live_chat, vec!["live_chat/a.json.gz"]);
    }

    #[test]
    fn a_channel_avatar_counts_as_a_referenced_thumbnail() {
        // The one decision in expected_library_paths with a user-visible cost. An avatar is
        // referenced by the channels table, not by any media row, so leaving it out reports it as
        // an orphan thumbnail. A file Diagnostics then invites the user to delete while the
        // sidebar is still drawing it.
        let references = vec![reference(
            1,
            10,
            "video/a.mp4",
            Some("thumbnails/a.jpg"),
            None,
        )];

        let expected =
            expected_library_paths(&references, vec!["thumbnails/avatar_10.jpg".to_string()]);

        assert!(expected
            .thumbnails
            .contains(&"thumbnails/a.jpg".to_string()));
        assert!(expected
            .thumbnails
            .contains(&"thumbnails/avatar_10.jpg".to_string()));
        // An avatar is not a media file and not a replay, so it must not widen either of those.
        assert_eq!(expected.media, vec!["video/a.mp4"]);
        assert!(expected.live_chat.is_empty());
    }

    #[test]
    fn only_the_reported_media_paths_get_a_target() {
        // The property this whole change rests on: the map is bounded by what the report named,
        // not by the size of the library. Resolving every reference is what it replaced.
        let references = vec![
            reference(1, 10, "video/gone.mp4", None, None),
            reference(2, 20, "video/empty.mp4", None, None),
            reference(3, 30, "video/healthy.mp4", None, None),
        ];

        let mut report = empty_report();
        report.missing_media_examples = vec!["video/gone.mp4".to_string()];
        report.corrupt_media_examples = vec!["video/empty.mp4".to_string()];

        let targets = media_targets_for_report(&report, &references);

        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets.get("video/gone.mp4"),
            Some(&DiagnosticsMediaTarget {
                channel_id: 10,
                media_id: 1
            })
        );
        // Corrupt media is navigable too. The row still exists, the file on disk is just hollow.
        assert_eq!(
            targets.get("video/empty.mp4"),
            Some(&DiagnosticsMediaTarget {
                channel_id: 20,
                media_id: 2
            })
        );
        assert!(!targets.contains_key("video/healthy.mp4"));
    }

    #[test]
    fn a_target_is_keyed_the_way_the_report_spells_the_path() {
        // A row stored with backslashes (a library written on Windows) has to resolve against the
        // forward-slash form the report echoes back, or the example renders with no jump action
        // and nothing anywhere says why.
        let references = vec![reference(1, 10, r"video\gone.mp4", None, None)];

        let mut report = empty_report();
        report.missing_media_examples = vec!["video/gone.mp4".to_string()];

        let targets = media_targets_for_report(&report, &references);

        assert_eq!(
            targets.get("video/gone.mp4"),
            Some(&DiagnosticsMediaTarget {
                channel_id: 10,
                media_id: 1
            })
        );
    }

    #[test]
    fn a_clean_report_resolves_no_targets_at_all() {
        // The common case, and the one that must not walk the references: nothing was reported,
        // so there is nothing to look up.
        let references = vec![reference(1, 10, "video/a.mp4", None, None)];

        assert!(media_targets_for_report(&empty_report(), &references).is_empty());
    }

    #[test]
    fn an_orphan_never_resolves_to_a_media_row() {
        // An orphan is by definition a file no row references, so it has no target, and the
        // orphan list must not be one of the sources the lookup set is built from.
        let references = vec![reference(1, 10, "video/a.mp4", None, None)];

        let mut report = empty_report();
        report.orphan_media_examples = vec!["video/a.mp4".to_string()];

        assert!(media_targets_for_report(&report, &references).is_empty());
    }

    #[test]
    fn the_check_reports_disk_state_and_the_targets_for_what_it_named() {
        let library = unique_test_dir("for-references");
        fs::create_dir_all(library.join("video")).unwrap();
        fs::create_dir_all(library.join("thumbnails")).unwrap();
        // Referenced and healthy.
        fs::write(library.join("video").join("a.mp4"), b"data").unwrap();
        // Referenced by a channel avatar, so it must not be reported as an orphan.
        fs::write(library.join("thumbnails").join("avatar_10.jpg"), b"img").unwrap();

        let references = vec![
            reference(1, 10, "video/a.mp4", None, None),
            // Referenced but not on disk.
            reference(2, 10, "video/gone.mp4", None, None),
        ];

        let check = check_library_integrity_for_references(
            library.to_string_lossy().as_ref(),
            references,
            vec!["thumbnails/avatar_10.jpg".to_string()],
        )
        .unwrap();

        assert_eq!(check.report.checked_media_files, 2);
        assert_eq!(check.report.missing_media_files, 1);
        assert_eq!(check.report.missing_media_examples, vec!["video/gone.mp4"]);
        assert_eq!(
            check.report.orphan_thumbnail_files, 0,
            "an avatar is referenced, so it is not an orphan"
        );

        assert_eq!(
            check.media_targets.get("video/gone.mp4"),
            Some(&DiagnosticsMediaTarget {
                channel_id: 10,
                media_id: 2
            })
        );
        assert_eq!(
            check.media_targets.len(),
            1,
            "the healthy media was not reported, so it needs no target"
        );

        let _ = fs::remove_dir_all(&library);
    }

    /// A report with every counter at zero, so a test can set only the field it is about.
    fn empty_report() -> LibraryIntegrityReport {
        LibraryIntegrityReport {
            checked_media_files: 0,
            missing_media_files: 0,
            missing_media_examples: Vec::new(),
            corrupt_media_files: 0,
            corrupt_media_examples: Vec::new(),
            checked_thumbnail_files: 0,
            missing_thumbnail_files: 0,
            missing_thumbnail_examples: Vec::new(),
            corrupt_thumbnail_files: 0,
            corrupt_thumbnail_examples: Vec::new(),
            orphan_media_files: 0,
            orphan_media_examples: Vec::new(),
            orphan_thumbnail_files: 0,
            orphan_thumbnail_examples: Vec::new(),
            invalid_media_files: 0,
            invalid_media_examples: Vec::new(),
            invalid_thumbnail_files: 0,
            invalid_thumbnail_examples: Vec::new(),
            checked_live_chat_files: 0,
            missing_live_chat_files: 0,
            missing_live_chat_examples: Vec::new(),
            corrupt_live_chat_files: 0,
            corrupt_live_chat_examples: Vec::new(),
            orphan_live_chat_files: 0,
            orphan_live_chat_examples: Vec::new(),
            invalid_live_chat_files: 0,
            invalid_live_chat_examples: Vec::new(),
        }
    }

    #[test]
    fn check_library_integrity_sync_reports_missing_and_orphan_files() {
        let library = unique_test_dir("service-integrity");
        fs::create_dir_all(library.join("video")).unwrap();
        fs::create_dir_all(library.join("live_chat")).unwrap();
        fs::write(library.join("video").join("a.mp4"), b"data").unwrap();
        // Not referenced by the database -> should be reported as an orphan.
        fs::write(library.join("video").join("orphan.mp4"), b"data").unwrap();
        // A referenced live chat file that is present but zero-length -> corrupt, not missing.
        fs::write(library.join("live_chat").join("a.json.gz"), b"").unwrap();
        // A live chat file on disk that no row references -> orphan.
        fs::write(library.join("live_chat").join("orphan.json.gz"), b"data").unwrap();

        let report = check_library_integrity_sync(
            library.to_string_lossy().as_ref(),
            vec!["video/a.mp4".to_string(), "video/missing.mp4".to_string()],
            vec!["thumbnails/missing.jpg".to_string()],
            vec![
                "live_chat/a.json.gz".to_string(),
                "live_chat/missing.json.gz".to_string(),
            ],
        )
        .unwrap();

        assert_eq!(report.checked_media_files, 2);
        assert_eq!(report.missing_media_files, 1);
        assert_eq!(report.checked_thumbnail_files, 1);
        assert_eq!(report.missing_thumbnail_files, 1);
        assert_eq!(report.orphan_media_files, 1);
        assert_eq!(report.orphan_media_examples, vec!["video/orphan.mp4"]);

        // Live chat now gets the same checks as media/thumbnails.
        assert_eq!(report.checked_live_chat_files, 2);
        assert_eq!(report.missing_live_chat_files, 1);
        assert_eq!(
            report.missing_live_chat_examples,
            vec!["live_chat/missing.json.gz"]
        );
        assert_eq!(report.corrupt_live_chat_files, 1);
        assert_eq!(
            report.corrupt_live_chat_examples,
            vec!["live_chat/a.json.gz"]
        );
        assert_eq!(report.orphan_live_chat_files, 1);
        assert_eq!(
            report.orphan_live_chat_examples,
            vec!["live_chat/orphan.json.gz"]
        );

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn collect_missing_paths_counts_existing_relative_path_as_not_missing() {
        let library = unique_test_dir("existing");
        fs::create_dir_all(library.join("video")).unwrap();
        fs::write(library.join("video").join("a.mp4"), b"data").unwrap();

        let outcome = collect_missing_paths(&library, vec!["video/a.mp4".to_string()]);

        assert_eq!(outcome.checked, 1);
        assert_eq!(outcome.missing, 0);
        assert_eq!(outcome.invalid, 0);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn collect_missing_paths_reports_zero_length_file_as_corrupt_not_missing() {
        let library = unique_test_dir("corrupt");
        fs::create_dir_all(library.join("video")).unwrap();
        // A present but zero-length file: a truncated/corrupted artifact, not a healthy one.
        fs::write(library.join("video").join("empty.mp4"), b"").unwrap();
        // A healthy file alongside it must stay uncounted as corrupt.
        fs::write(library.join("video").join("ok.mp4"), b"data").unwrap();

        let outcome = collect_missing_paths(
            &library,
            vec!["video/empty.mp4".to_string(), "video/ok.mp4".to_string()],
        );

        assert_eq!(outcome.checked, 2);
        assert_eq!(outcome.missing, 0);
        assert_eq!(outcome.corrupt, 1);
        assert_eq!(outcome.corrupt_examples, vec!["video/empty.mp4"]);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn collect_missing_paths_counts_missing_relative_path() {
        let library = unique_test_dir("missing");
        fs::create_dir_all(&library).unwrap();

        let outcome = collect_missing_paths(&library, vec!["video/missing.mp4".to_string()]);

        assert_eq!(outcome.checked, 1);
        assert_eq!(outcome.missing, 1);
        assert_eq!(outcome.missing_examples, vec!["video/missing.mp4"]);
        assert_eq!(outcome.invalid, 0);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn collect_missing_paths_reports_absolute_path_outside_library_as_invalid() {
        let library = unique_test_dir("outside");
        fs::create_dir_all(&library).unwrap();

        let outside = std::env::temp_dir().to_string_lossy().to_string();

        let outcome = collect_missing_paths(&library, vec![outside]);

        // A stale absolute path resolves outside the library: it is an anomaly, not something
        // to silently drop.
        assert_eq!(outcome.checked, 0);
        assert_eq!(outcome.missing, 0);
        assert_eq!(outcome.invalid, 1);
        assert_eq!(outcome.invalid_examples.len(), 1);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn collect_missing_paths_reports_relative_path_with_parent_traversal_as_invalid() {
        let library = unique_test_dir("traversal");
        fs::create_dir_all(&library).unwrap();

        let outcome = collect_missing_paths(
            &library,
            vec![
                "../outside.txt".to_string(),
                "video/../../secret".to_string(),
            ],
        );

        assert_eq!(outcome.checked, 0);
        assert_eq!(outcome.missing, 0);
        assert_eq!(outcome.invalid, 2);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    #[cfg(unix)]
    fn collect_missing_paths_treats_symlink_pointing_outside_library_as_missing() {
        use std::os::unix::fs::symlink;

        let library = unique_test_dir("symlink");
        let outside = unique_test_dir("symlink-outside");

        fs::create_dir_all(&library).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.mp4"), b"secret").unwrap();

        // Create a symlink inside the library that points outside
        symlink(&outside, library.join("link")).unwrap();

        let outcome = collect_missing_paths(&library, vec!["link/secret.mp4".to_string()]);

        // The path appears to be inside the library via starts_with, but after
        // canonicalization it resolves outside. Must be treated as missing
        assert_eq!(outcome.checked, 1);
        assert_eq!(outcome.missing, 1);

        let _ = fs::remove_dir_all(&library);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn collect_missing_paths_deduplicates_repeated_paths() {
        let library = unique_test_dir("dedup");
        fs::create_dir_all(&library).unwrap();

        let outcome = collect_missing_paths(
            &library,
            vec![
                "video/a.mp4".to_string(),
                "video/a.mp4".to_string(),
                "  video/a.mp4  ".to_string(),
            ],
        );

        assert_eq!(outcome.checked, 1);
        assert_eq!(outcome.missing, 1);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn every_example_list_is_capped_while_its_count_stays_complete() {
        // The report's counts are the answer; the example lists are a sample of each. Both halves
        // are asserted here because they fail in opposite directions: a cap applied to the count
        // would under-report the damage, and a cap missing from the list would put every path in a
        // library-sized report onto the IPC boundary.
        //
        // All three of `collect_missing_paths`' lists in one test, because they are one decision
        // written three times and splitting them would only pin whichever one a later edit did not
        // touch. `collect_orphan_paths` has the fourth copy and gets its own test below, since it
        // takes different inputs.
        let library = unique_test_dir("example-cap");
        fs::create_dir_all(library.join("video")).unwrap();

        let over_cap = MAX_EXAMPLES + 1;
        let mut stored = Vec::new();

        for index in 0..over_cap {
            // Absent from disk.
            stored.push(format!("video/missing-{index}.mp4"));

            // Present but hollow, which is corrupt rather than fine.
            let zero_length = library.join("video").join(format!("empty-{index}.mp4"));
            fs::write(&zero_length, b"").unwrap();
            stored.push(format!("video/empty-{index}.mp4"));

            // Escapes the library, which is an anomaly rather than a miss.
            stored.push(format!("video/../../outside-{index}.mp4"));
        }

        let outcome = collect_missing_paths(&library, stored);

        assert_eq!(outcome.missing, over_cap, "every missing path is counted");
        assert_eq!(outcome.corrupt, over_cap, "every hollow file is counted");
        assert_eq!(outcome.invalid, over_cap, "every escaping path is counted");

        // Exactly the cap, not merely "at most": `<=` in the guard stores one more than the
        // constant says, which is the off-by-one no count above can reveal.
        assert_eq!(outcome.missing_examples.len(), MAX_EXAMPLES);
        assert_eq!(outcome.corrupt_examples.len(), MAX_EXAMPLES);
        assert_eq!(outcome.invalid_examples.len(), MAX_EXAMPLES);

        let _ = fs::remove_dir_all(&library);
    }

    #[test]
    fn the_orphan_example_list_is_capped_while_its_count_stays_complete() {
        // The fourth copy of the cap above, on the one list built from what is on disk rather than
        // from what the database stored. Same two directions asserted for the same reason: the
        // count is what tells the user how much is there, and the list is what crosses IPC.
        let library = unique_test_dir("orphan-cap");
        fs::create_dir_all(library.join("video")).unwrap();

        let over_cap = MAX_EXAMPLES + 1;

        for index in 0..over_cap {
            fs::write(
                library.join("video").join(format!("stray-{index}.mp4")),
                b"x",
            )
            .unwrap();
        }

        // Nothing is referenced, so every file on disk is an orphan.
        let expected = HashSet::new();
        let (count, examples) = collect_orphan_paths(&library, &["video"], &expected);

        assert_eq!(count, over_cap, "every unreferenced file is counted");
        assert_eq!(examples.len(), MAX_EXAMPLES);

        let _ = fs::remove_dir_all(&library);
    }
}
