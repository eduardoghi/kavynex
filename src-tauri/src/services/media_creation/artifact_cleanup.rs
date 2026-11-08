//! Removing what a failed creation left in the library, reference-counted against the rows that
//! may already use the same files. Named apart from `library::cleanup`, which it calls.

use super::*;

/// True when no artifact was named, i.e. when there is nothing for the cleanup to do.
///
/// Pure, and extracted, because weakening the `&&` chain to `||` turns it into "return
/// early if any of the three is absent", and the common shape is a creation that produced a media
/// file and no live chat replay, so the cleanup would be skipped exactly when it has real work. The
/// caller is `AppHandle`-bound, so nothing can observe that unless the predicate lives here.
///
/// Phrased negatively so the caller reads `if nothing_to_clean_up(..) { return; }` with no `!`. That
/// is not style. A `!` at the call site is a restatement of this function's polarity, and deleting
/// it is a mutant that inverts the guard inside a function no unit test can drive. Removing the
/// restatement removes the mutant, which beats excluding it. The same resolution as
/// `thumbnail::display::take_generation_slot`.
pub(crate) fn nothing_to_clean_up(
    file_path: Option<&str>,
    thumbnail_path: Option<&str>,
    live_chat_file_path: Option<&str>,
) -> bool {
    file_path.is_none() && thumbnail_path.is_none() && live_chat_file_path.is_none()
}

/// Logs whatever the reference-counted cleanup reported, and swallows any failure.
///
/// Every caller is already unwinding a failure, so a cleanup that itself fails must not replace the
/// error the user needs to see. What is left behind in that case is an unreferenced file, which
/// Diagnostics reports. The recoverable outcome.
///
/// Shared by both wrappers below rather than written twice. The two differ only in which cleanup
/// they call (one holds the registration lock, one takes it), and duplicating the reporting would
/// duplicate a `warn` whose only observable effect is the log line.
pub(super) fn report_cleanup_outcome(outcome: &AppResult<library::cleanup::ArtifactCleanupReport>) {
    match outcome {
        Ok(report) if !report.failed_paths.is_empty() => logger::warn(
            "media_creation",
            format!(
                "{} artifact(s) prepared for a failed media creation could not be removed; they \
                 are reported by Diagnostics as unreferenced files",
                report.failed_paths.len()
            ),
        ),
        Ok(_) => {}
        Err(error) => logger::warn(
            "media_creation",
            format!("failed to clean up the artifacts of a failed media creation: {error}"),
        ),
    }
}

/// Hands artifacts to the reference-counted cleanup, taking the registration lock.
pub(super) async fn cleanup_artifacts_best_effort<R: Runtime>(
    app: &AppHandle<R>,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    live_chat_file_path: Option<String>,
) {
    if nothing_to_clean_up(
        file_path.as_deref(),
        thumbnail_path.as_deref(),
        live_chat_file_path.as_deref(),
    ) {
        return;
    }

    report_cleanup_outcome(
        &library::cleanup::cleanup_unreferenced_artifacts(
            app,
            file_path,
            thumbnail_path,
            live_chat_file_path,
        )
        .await,
    );
}

/// The media file a failed registration may hand to the cleanup, or to the startup sweep through the
/// marker. `None` when the library file is the only copy of the user's file.
///
/// Pure, and shared by both, because a wrong answer here deletes the user's file. The cleanup removes
/// whatever no row references, which after a refused insert includes the only copy. A refused
/// insert puts a renamed file back where the user had it (`put_renamed_file_back`), and one that
/// cannot go back is named in the error.
pub(crate) fn deletable_media_file(prepared: &PreparedArtifacts) -> Option<String> {
    if prepared.media_file_is_only_copy {
        return None;
    }

    Some(prepared.file_path.clone())
}

/// The same cleanup, for a caller that already holds the registration lock. Takes the whole
/// `PreparedArtifacts` because that caller always has one. Returns whether it left nothing behind
/// (see `pending_media::cleanup_reconciled`), which decides whether the marker can go.
pub(super) async fn cleanup_artifacts_best_effort_locked<R: Runtime>(
    app: &AppHandle<R>,
    prepared: &PreparedArtifacts,
) -> bool {
    let file_path = deletable_media_file(prepared);

    if nothing_to_clean_up(
        file_path.as_deref(),
        prepared.thumbnail_path.as_deref(),
        prepared.live_chat_file_path.as_deref(),
    ) {
        return true;
    }

    // Into the library's trash rather than unlinked. A finished download whose insert failed may be
    // of something no longer on YouTube.
    let outcome = library::cleanup::trash_unreferenced_artifacts_locked(
        app,
        file_path,
        prepared.thumbnail_path.clone(),
        prepared.live_chat_file_path.clone(),
    )
    .await;
    report_cleanup_outcome(&outcome);

    pending_media::cleanup_reconciled(&outcome)
}

/// Removes a Move import's source now that a row points at the library copy.
///
/// Best effort. The media is registered and complete either way, so a source that cannot be removed
/// (another program holding it open on Windows, a read-only folder) is left where it was and
/// logged, which turns this one Move into a Copy rather than failing a creation that succeeded.
///
/// Returns whether a source was left in place.
pub(super) async fn remove_move_source_best_effort(source: Option<PathBuf>) -> bool {
    let Some(source) = source else {
        return false;
    };

    let removed =
        run_blocking(move || library::media::remove_moved_import_source_sync(&source)).await;

    match removed {
        Ok(()) => false,
        Err(error) => {
            logger::warn(
                "media_creation",
                format!(
                    "the media was imported, but its original file could not be removed: {error}"
                ),
            );
            true
        }
    }
}
