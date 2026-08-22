// The tests for the parent module, kept in a file of their own so the module reads as its
// production code. Same module as before (`mod tests` declared under `#[cfg(test)]` in the
// parent), so `use super::*` still reaches every private item it did.

use super::*;
use std::thread::sleep;
use std::time::Duration;

#[test]
fn the_cancellable_copy_chunk_is_one_mebibyte() {
    // Pinned by value rather than re-derived from the same multiplication the constant uses,
    // matching `the_live_chat_decompression_ceiling_is_512_mib` in `live_chat_storage`. An
    // arithmetic slip here is invisible to every behavioral test: 1024 + 1024 is 2048 bytes and
    // 1024 / 1024 is 1, and a copy still produces a byte-identical destination at any of those
    // sizes. What changes is only how often a cancel can be noticed. A one-byte chunk turns
    // the cancellable import into a syscall per byte, which is a hang the user reads as a
    // freeze rather than as a slow copy. A literal is the only thing that catches it.
    assert_eq!(CANCELLABLE_COPY_CHUNK_BYTES, 1_048_576);
}

/// How many `.tmp-` staging files the copy left behind in `dir`. A cancel that stranded one
/// would be invisible to an assertion on the destination alone, and the whole point of staging
/// through a sibling is that nothing survives a copy that did not finish.
fn staging_files_in(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
                .count()
        })
        .unwrap_or(0)
}

#[test]
fn a_cancelled_copy_leaves_neither_a_destination_nor_a_staging_file() {
    // The property the whole staging design rests on, applied to the new exit. A cancel is the
    // one failure that arrives while the temp file is perfectly healthy (it is simply
    // incomplete), so the branch that removes it has to fire for a cancel exactly as it does
    // for a disk-full or a permission error. Leaving a partial `.tmp-` behind would strand
    // scratch in the user's library; leaving the destination behind would be far worse, since
    // its name is a content hash of bytes it does not hold.
    let dir = unique_test_dir();
    std::fs::create_dir_all(&dir).unwrap();

    let source = dir.join("source.mp4");
    std::fs::write(&source, b"some media bytes").unwrap();
    let destination = dir.join("video").join("media_abc.mp4");

    let cancel = AtomicBool::new(true);
    let error = copy_file_atomic_cancellable(&source, &destination, Some(&cancel)).unwrap_err();

    assert_eq!(error.code, AppErrorCode::MediaImportCancelled.as_str());
    assert!(
        !destination.exists(),
        "a cancelled copy must produce nothing"
    );
    assert_eq!(
        staging_files_in(destination.parent().unwrap()),
        0,
        "a cancelled copy must not strand its staging file"
    );
    assert!(
        source.exists(),
        "a cancelled copy must not touch the source"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_cancellable_copy_produces_the_same_file_as_the_plain_one() {
    // The chunked loop replaces `fs::copy` on this path, so it has to be byte-for-byte
    // equivalent. A content-addressed name is a hash of these bytes, so a copy that dropped or
    // duplicated a chunk would store a file under a name that no longer describes it, and every
    // later lookup by hash would miss it. Sized past one chunk on purpose: a single-chunk file
    // would pass even if the loop only ever ran once.
    let dir = unique_test_dir();
    std::fs::create_dir_all(&dir).unwrap();

    let payload: Vec<u8> = (0..(CANCELLABLE_COPY_CHUNK_BYTES * 2 + 1234))
        .map(|index| (index % 251) as u8)
        .collect();

    let source = dir.join("source.mp4");
    std::fs::write(&source, &payload).unwrap();

    let chunked = dir.join("chunked.mp4");
    let whole = dir.join("whole.mp4");

    let cancel = AtomicBool::new(false);
    copy_file_atomic_cancellable(&source, &chunked, Some(&cancel)).unwrap();
    copy_file_atomic(&source, &whole).unwrap();

    assert_eq!(std::fs::read(&chunked).unwrap(), payload);
    assert_eq!(
        std::fs::read(&chunked).unwrap(),
        std::fs::read(&whole).unwrap()
    );
    assert_eq!(file_hash(&chunked).unwrap(), file_hash(&source).unwrap());
    assert_eq!(staging_files_in(&dir), 0);

    let _ = std::fs::remove_dir_all(&dir);
}

fn unique_test_dir() -> PathBuf {
    // Via unique_temp_suffix rather than pid + nanos: that pair is not collision-proof, because
    // tests run concurrently and share the pid, so two calls landing in the same nanosecond (more
    // likely on a coarser macOS timer) would get the same directory and clobber each other's
    // files. A real intermittent CI failure. The suffix's monotonic counter is what makes every
    // call distinct regardless of timer resolution.
    std::env::temp_dir().join(format!(
        "kavynex-filesystem-test-{}",
        crate::utils::naming::unique_temp_suffix()
    ))
}

#[test]
fn verify_content_addressed_write_keeps_a_matching_name() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let content = b"the real bytes";
    let scratch = dir.join("scratch");
    fs::write(&scratch, content).unwrap();
    let hash = file_hash(&scratch).unwrap();
    let _ = fs::remove_file(&scratch);

    let written = dir.join(format!("media_{hash}.mp4"));
    fs::write(&written, content).unwrap();

    // The name already matches the content, so nothing moves.
    let result = verify_content_addressed_write(&written, &hash, "media", "mp4").unwrap();
    assert_eq!(result, written);
    assert!(written.exists());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn verify_content_addressed_write_corrects_a_name_built_from_a_stale_hash() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    // The name was built from a hash of the source taken before the write, but the bytes that
    // actually landed differ (a source changed in the TOCTOU window).
    let written = dir.join("media_stalehash.mp4");
    fs::write(&written, b"the bytes that actually landed").unwrap();
    let actual = file_hash(&written).unwrap();

    let result = verify_content_addressed_write(&written, "stalehash", "media", "mp4").unwrap();

    let corrected = dir.join(format!("media_{actual}.mp4"));
    assert_eq!(result, corrected);
    assert!(
        corrected.exists(),
        "the file must be renamed to its real hash"
    );
    assert!(!written.exists(), "the mis-named file must be gone");
    assert_eq!(
        fs::read(&corrected).unwrap(),
        b"the bytes that actually landed"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn verify_content_addressed_write_drops_a_mis_named_copy_when_the_correct_name_exists() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let content = b"already-catalogued bytes";
    let mis_named = dir.join("media_stalehash.mp4");
    fs::write(&mis_named, content).unwrap();
    let actual = file_hash(&mis_named).unwrap();

    // The real content was already stored under its correct name before this fresh, mis-named
    // copy landed, so the mis-named one is dropped rather than overwriting the catalogued bytes.
    let correct = dir.join(format!("media_{actual}.mp4"));
    fs::write(&correct, content).unwrap();

    let result = verify_content_addressed_write(&mis_named, "stalehash", "media", "mp4").unwrap();

    assert_eq!(result, correct);
    assert!(
        !mis_named.exists(),
        "the redundant mis-named copy must be dropped"
    );
    assert!(correct.exists());

    let _ = fs::remove_dir_all(&dir);
}

// Symlink creation is unprivileged on Unix but needs Developer Mode/admin on Windows, so the
// cycle-safety test runs on Unix only. The guarded code (`dir_entry_is_symlink`) is
// platform-independent; this exercises it where a symlink can always be created.
#[cfg(unix)]
#[test]
fn copy_directory_contents_does_not_follow_a_symlink_cycle() {
    use std::os::unix::fs::symlink;

    let base = unique_test_dir();
    let source = base.join("source");
    let nested = source.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(source.join("real.txt"), b"data").unwrap();

    // A symlink inside the tree pointing back at its own root: following it would recurse
    // forever. Without the symlink guard this call would overflow the stack rather than return.
    symlink(&source, nested.join("loop")).unwrap();

    let destination = base.join("destination");
    copy_directory_contents(&source, &destination).unwrap();

    // The real file is copied; the symlink is skipped, so no `loop` entry is carried over.
    assert!(destination.join("real.txt").is_file());
    assert!(!destination.join("nested").join("loop").exists());

    let _ = fs::remove_dir_all(&base);
}

/// Names of the `.<file>.backup-<suffix>` scratch files `replace_file_safely` creates, so a
/// test can assert it cleaned up after itself rather than leaving one in the library.
fn leftover_backup_names(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".backup-"))
        .collect()
}

// The guard these three functions exist for: a destination that already holds *different*
// bytes is someone else's file, and must come back as an error with the file untouched. Only
// the identical-content path may proceed. A flipped comparison here would not fail loudly
// (it would silently overwrite a file in the user's library), so each test asserts the
// destination's bytes are unchanged, not just that an error came back.

#[test]
fn copy_file_atomic_rejects_a_destination_holding_different_content() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let source = dir.join("source.mp4");
    let destination = dir.join("destination.mp4");
    fs::write(&source, b"incoming bytes").unwrap();
    fs::write(&destination, b"an existing user file").unwrap();

    let error = copy_file_atomic(&source, &destination).unwrap_err();

    assert_eq!(error.code, AppErrorCode::DestinationAlreadyExists.as_str());
    assert_eq!(fs::read(&destination).unwrap(), b"an existing user file");
    assert!(
        source.exists(),
        "a rejected copy must not consume the source"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn move_or_copy_file_rejects_a_destination_holding_different_content() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let source = dir.join("source.mp4");
    let destination = dir.join("destination.mp4");
    fs::write(&source, b"incoming bytes").unwrap();
    fs::write(&destination, b"an existing user file").unwrap();

    let error = move_or_copy_file(&source, &destination).unwrap_err();

    assert_eq!(error.code, AppErrorCode::DestinationAlreadyExists.as_str());
    assert_eq!(fs::read(&destination).unwrap(), b"an existing user file");
    // A move that refused to happen must leave the source in place: removing it here would
    // destroy the only copy of the file the caller asked to move.
    assert!(
        source.exists(),
        "a rejected move must not consume the source"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn replace_file_safely_moves_the_source_in_when_no_destination_exists() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let source = dir.join("source.json");
    let destination = dir.join("nested").join("destination.json");
    fs::write(&source, b"fresh content").unwrap();

    replace_file_safely(&source, &destination).unwrap();

    assert_eq!(fs::read(&destination).unwrap(), b"fresh content");
    assert!(
        !source.exists(),
        "the source should have been moved, not copied"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn replace_file_safely_overwrites_an_existing_destination_and_leaves_no_backup() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let source = dir.join("source.json");
    let destination = dir.join("destination.json");
    fs::write(&source, b"new content").unwrap();
    fs::write(&destination, b"stale content").unwrap();

    replace_file_safely(&source, &destination).unwrap();

    assert_eq!(fs::read(&destination).unwrap(), b"new content");
    // Unlike copy_file_atomic/move_or_copy_file, this one is *meant* to replace differing
    // content. That is the whole point of the backup dance. What it must not do is leave the
    // scratch backup behind once the replace succeeded.
    assert_eq!(leftover_backup_names(&dir), Vec::<String>::new());

    let _ = fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn replace_file_safely_restores_the_original_when_the_replace_fails() {
    // The branch that justifies the backup dance existing at all: the destination has already
    // been renamed aside when the replace fails, so without the restore the user is left with
    // no file at all where their data used to be.
    //
    // Unix-only because making the replace fail *after* the backup succeeded needs the rename
    // of the source to be refused, which means taking write permission off the source's own
    // directory. The destination's directory has to stay writable for the backup and the
    // restore themselves. Windows has no portable equivalent (its read-only attribute does not
    // block a rename), so this branch is covered on Linux/macOS CI only.
    use std::os::unix::fs::PermissionsExt;

    let dir = unique_test_dir();
    let source_dir = dir.join("source-dir");
    let destination_dir = dir.join("destination-dir");
    fs::create_dir_all(&source_dir).unwrap();
    fs::create_dir_all(&destination_dir).unwrap();

    let source = source_dir.join("source.json");
    let destination = destination_dir.join("destination.json");
    fs::write(&source, b"new content").unwrap();
    fs::write(&destination, b"the original file").unwrap();

    // Renaming a file out of a directory needs write permission on that directory.
    fs::set_permissions(&source_dir, fs::Permissions::from_mode(0o555)).unwrap();

    let error = replace_file_safely(&source, &destination).unwrap_err();

    // The original error is reported, not a restore failure.
    assert_eq!(error.code, AppErrorCode::FileMoveFailed.as_str());
    // What actually matters: the destination is back, byte for byte, and no backup is orphaned.
    assert_eq!(fs::read(&destination).unwrap(), b"the original file");
    assert_eq!(
        leftover_backup_names(&destination_dir),
        Vec::<String>::new()
    );

    fs::set_permissions(&source_dir, fs::Permissions::from_mode(0o755)).unwrap();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn find_best_matching_file_prefers_requested_extension() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let png = dir.join("thumb_test.png");
    let jpg = dir.join("thumb_test.jpg");

    fs::write(&jpg, b"jpg").unwrap();
    sleep(Duration::from_millis(5));
    fs::write(&png, b"png").unwrap();

    let found = find_best_matching_file(&dir, "thumb_test.", Some("png")).unwrap();
    assert_eq!(
        found.file_name().unwrap().to_string_lossy(),
        "thumb_test.png"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn find_best_matching_file_falls_back_to_most_recent_when_preferred_missing() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let older = dir.join("media_test.webm");
    let newer = dir.join("media_test.mkv");

    fs::write(&older, b"older").unwrap();
    sleep(Duration::from_millis(5));
    fs::write(&newer, b"newer").unwrap();

    let found = find_best_matching_file(&dir, "media_test.", Some("mp4")).unwrap();
    assert_eq!(
        found.file_name().unwrap().to_string_lossy(),
        "media_test.mkv"
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn find_best_matching_file_returns_error_when_no_match_exists() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let result = find_best_matching_file(&dir, "missing_prefix.", Some("png"));
    assert!(result.is_err());

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn find_best_matching_file_prefers_the_extension_over_a_newer_non_preferred_file() {
    // The existing preference test writes the preferred file last, so recency alone would pick
    // it too, which lets a flipped preference comparison slip through. Make the preferred file
    // the *older* one so preference has to beat recency, pinning that comparison.
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let png = dir.join("thumb_x.png");
    let jpg = dir.join("thumb_x.jpg");
    fs::write(&png, b"png").unwrap(); // preferred, but older
    sleep(Duration::from_millis(20));
    fs::write(&jpg, b"jpg").unwrap(); // newer, not preferred

    let found = find_best_matching_file(&dir, "thumb_x.", Some("png")).unwrap();
    assert_eq!(found.file_name().unwrap().to_string_lossy(), "thumb_x.png");

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn matching_helpers_ignore_a_prefix_named_subdirectory() {
    // A subdirectory whose name starts with the prefix is not a "matching file": the filters
    // pair starts_with(prefix) with is_file(). The directory is made *newer* than the file, so
    // a filter that dropped the is_file() half (matching the directory too) would return or
    // count it. Each helper must still resolve to the file.
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("media_x.mp4");
    fs::write(&file, b"real").unwrap();
    sleep(Duration::from_millis(20));
    fs::create_dir_all(dir.join("media_x_dir")).unwrap();

    assert_eq!(find_latest_matching_file(&dir, "media_x").unwrap(), file);
    assert_eq!(find_unique_matching_file(&dir, "media_x").unwrap(), file);
    assert_eq!(
        find_best_matching_file(&dir, "media_x", None).unwrap(),
        file
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn matching_helpers_reject_a_non_directory_path() {
    // A path that exists but is a file must come back as the catalogued MatchingFileNotFound,
    // not an attempt to read it as a directory (which would surface a different error).
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("not_a_dir");
    fs::write(&file, b"x").unwrap();

    for result in [
        find_latest_matching_file(&file, "x"),
        find_unique_matching_file(&file, "x"),
        find_best_matching_file(&file, "x", None),
    ] {
        let error = result.expect_err("a file path is not a searchable directory");
        assert_eq!(error.code, AppErrorCode::MatchingFileNotFound.as_str());
    }

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn find_latest_matching_file_returns_the_most_recent_match() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();
    let older = dir.join("run_a.log");
    let newer = dir.join("run_b.log");
    fs::write(&older, b"a").unwrap();
    sleep(Duration::from_millis(20));
    fs::write(&newer, b"b").unwrap();

    assert_eq!(find_latest_matching_file(&dir, "run_").unwrap(), newer);
    assert!(find_latest_matching_file(&dir, "none_").is_err());

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn find_unique_matching_file_distinguishes_none_one_and_many() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    // None: the catalogued not-found code, not a silent success.
    let none = find_unique_matching_file(&dir, "only_").unwrap_err();
    assert_eq!(none.code, AppErrorCode::MatchingFileNotFound.as_str());

    // Exactly one: returned.
    let one = dir.join("only_1.txt");
    fs::write(&one, b"1").unwrap();
    assert_eq!(find_unique_matching_file(&dir, "only_").unwrap(), one);

    // Two: the distinct multiple-match error, never a quiet pick of one.
    fs::write(dir.join("only_2.txt"), b"2").unwrap();
    let many = find_unique_matching_file(&dir, "only_").unwrap_err();
    assert_eq!(many.code, AppErrorCode::MultipleMatchingFilesFound.as_str());

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn clean_matching_files_in_dir_removes_only_prefix_matches() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();
    let matching = dir.join("tmp_a");
    let other = dir.join("keep_b");
    fs::write(&matching, b"a").unwrap();
    fs::write(&other, b"b").unwrap();

    clean_matching_files_in_dir(&dir, "tmp_").unwrap();

    assert!(!matching.exists(), "a prefix match must be removed");
    assert!(other.exists(), "a non-matching file must be left alone");

    // A missing directory is a no-op, not an error.
    clean_matching_files_in_dir(&unique_test_dir(), "tmp_").unwrap();

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn copy_file_atomic_writes_destination_with_source_content() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let source = dir.join("source.bin");
    // A nested destination whose parent does not exist yet, to also cover create_dir_all.
    let destination = dir.join("nested").join("copied.bin");

    fs::write(&source, b"durable-bytes").unwrap();

    copy_file_atomic(&source, &destination).unwrap();

    assert!(destination.exists());
    assert_eq!(fs::read(&destination).unwrap(), b"durable-bytes");
    // The source must remain in place (copy, not move).
    assert!(source.exists());
    // No leftover temp file next to the destination.
    let leftover_temp = fs::read_dir(destination.parent().unwrap())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".copied.bin.tmp-")
        });
    assert!(!leftover_temp, "temp file should have been renamed away");

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn copy_file_atomic_is_idempotent_when_destination_already_has_same_content() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let source = dir.join("source.txt");
    let destination = dir.join("destination.txt");

    fs::write(&source, b"same-content").unwrap();
    fs::write(&destination, b"same-content").unwrap();

    let result = copy_file_atomic(&source, &destination);
    assert!(result.is_ok());

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn find_unique_matching_file_returns_single_match() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let target = dir.join("media_abc.mp4");
    fs::write(&target, b"abc").unwrap();

    let result = find_unique_matching_file(&dir, "media_").unwrap();

    assert_eq!(
        result.file_name().and_then(|v| v.to_str()),
        Some("media_abc.mp4")
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn find_unique_matching_file_rejects_multiple_matches() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    fs::write(dir.join("media_a.mp4"), b"a").unwrap();
    fs::write(dir.join("media_b.mp4"), b"b").unwrap();

    let result = find_unique_matching_file(&dir, "media_");

    assert!(result.is_err());
    assert_eq!(
        result.err().unwrap().code,
        AppErrorCode::MultipleMatchingFilesFound.as_str()
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn find_best_matching_file_prefers_extension_when_available() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    fs::write(dir.join("video_001.webm"), b"webm").unwrap();
    fs::write(dir.join("video_001.mp4"), b"mp4").unwrap();

    let result = find_best_matching_file(&dir, "video_001.", Some("mp4")).unwrap();

    assert_eq!(
        result.file_name().and_then(|v| v.to_str()),
        Some("video_001.mp4")
    );

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn copy_directory_contents_copies_files_without_deleting_source() {
    let source_dir = unique_test_dir();
    let destination_dir = unique_test_dir();

    let nested = source_dir.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(source_dir.join("root.txt"), b"root").unwrap();
    fs::write(nested.join("child.txt"), b"child").unwrap();

    copy_directory_contents(&source_dir, &destination_dir).unwrap();

    assert!(destination_dir.join("root.txt").exists());
    assert!(destination_dir.join("nested").join("child.txt").exists());

    // source must remain intact
    assert!(source_dir.join("root.txt").exists());
    assert!(nested.join("child.txt").exists());

    let _ = fs::remove_dir_all(source_dir);
    let _ = fs::remove_dir_all(destination_dir);
}

#[test]
fn copy_directory_contents_is_idempotent_for_same_content() {
    let source_dir = unique_test_dir();
    let destination_dir = unique_test_dir();

    fs::create_dir_all(&source_dir).unwrap();
    fs::write(source_dir.join("a.txt"), b"same").unwrap();
    fs::create_dir_all(&destination_dir).unwrap();
    fs::write(destination_dir.join("a.txt"), b"same").unwrap();

    // second copy of the same file is a no-op, not an error
    copy_directory_contents(&source_dir, &destination_dir).unwrap();

    assert!(source_dir.join("a.txt").exists());
    assert!(destination_dir.join("a.txt").exists());

    let _ = fs::remove_dir_all(source_dir);
    let _ = fs::remove_dir_all(destination_dir);
}

#[test]
fn copy_directory_contents_returns_ok_when_source_does_not_exist() {
    let source_dir = unique_test_dir();
    let destination_dir = unique_test_dir();

    let result = copy_directory_contents(&source_dir, &destination_dir);
    assert!(result.is_ok());

    let _ = fs::remove_dir_all(destination_dir);
}

#[test]
fn copy_directory_contents_rejects_non_directory_source() {
    let source_dir = unique_test_dir();
    let destination_dir = unique_test_dir();

    fs::create_dir_all(&destination_dir).unwrap();
    fs::write(&source_dir, b"not-a-directory").unwrap();

    let result = copy_directory_contents(&source_dir, &destination_dir);
    assert!(result.is_err());
    assert_eq!(
        result.err().unwrap().code,
        AppErrorCode::InvalidSourceDirectory.as_str()
    );

    let _ = fs::remove_file(source_dir);
    let _ = fs::remove_dir_all(destination_dir);
}

#[test]
fn move_or_copy_file_is_noop_when_source_equals_destination() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let file = dir.join("media_hash.mp4");
    fs::write(&file, b"the only copy").unwrap();

    // Moving a file onto itself must never delete it.
    move_or_copy_file(&file, &file).unwrap();

    assert!(file.exists());
    assert_eq!(fs::read(&file).unwrap(), b"the only copy");

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn move_or_copy_file_removes_source_when_destination_has_same_content() {
    let dir = unique_test_dir();
    fs::create_dir_all(&dir).unwrap();

    let source = dir.join("source.mp4");
    let destination = dir.join("media_hash.mp4");
    fs::write(&source, b"same bytes").unwrap();
    fs::write(&destination, b"same bytes").unwrap();

    // Distinct paths with identical content: the source is a redundant duplicate and is
    // removed, leaving the destination intact.
    move_or_copy_file(&source, &destination).unwrap();

    assert!(!source.exists());
    assert!(destination.exists());
    assert_eq!(fs::read(&destination).unwrap(), b"same bytes");

    let _ = fs::remove_dir_all(dir);
}
