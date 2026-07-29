//! A cache of display-sized copies of the library's thumbnails.
//!
//! The library stores a thumbnail at whatever size it arrived: yt-dlp's `maxresdefault` is
//! 1280x720, and an FFmpeg frame is capped at 640 wide. The grid draws them into a card a few
//! hundred pixels across, and a webview decodes an image at its natural size - `width * height * 4`
//! bytes of bitmap - regardless of how well the file is compressed. So the grid pays for the full
//! 1280x720 decode of every visible card, and pays it again whenever the webview evicts and
//! re-decodes on a scroll back. Virtualization does not help: it bounds how many cards are in the
//! DOM, not how large each one's image is.
//!
//! Switching the stored thumbnails to JPEG (see [`crate::constants::THUMBNAIL_OUTPUT_FORMAT`])
//! addressed disk and I/O and could not address this - compression does not change a decoded
//! bitmap - and it only applied to files written after it landed, because names are
//! content-addressed and nothing re-encodes retroactively.
//!
//! This module is the separate change that does. It keeps a **derived** copy of each thumbnail,
//! scaled to [`DISPLAY_THUMBNAIL_MAX_WIDTH`], under the app cache directory, and that placement is
//! the whole design:
//!
//! - **Nothing in the database changes.** `videos.thumbnail_path` and `channels.avatar_path` keep
//!   pointing at the canonical file in the library. A derivative is addressed *by* the canonical
//!   file's content hash, which is already in its name, so the mapping needs no storage of its own.
//! - **It is disposable.** The cache directory is already swept of stale entries on startup
//!   (`services::cleanup`), and a missing derivative regenerates on demand, so losing the whole
//!   directory costs one re-encode and never a user's data.
//! - **It is retroactive.** A thumbnail that has been in the library for a year gets a derivative
//!   the first time it is asked for, which is what the format switch could not do.
//! - **It fails open.** Every failure path - an unreadable source, a missing FFmpeg, a refused
//!   cache directory - returns `None` for that entry, and the caller renders the canonical file
//!   exactly as before. A slow card is better than a blank one.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::constants::{
    DISPLAY_THUMBNAIL_MAX_WIDTH, LIBRARY_DIR_THUMBNAILS, THUMBNAIL_OUTPUT_FORMAT,
};
use crate::services::binaries::resolve_ffmpeg_binary;
use crate::services::logger;
use crate::services::temp_paths::thumb_display_dir;
use crate::utils::path::{absolute_path_from_relative, ensure_relative_path_in_managed_dir};
use crate::utils::process::{
    configure_process_group_blocking, hide_console, kill_process_tree_blocking,
};
use crate::AppResult;

/// How long one derivative generation may run before FFmpeg is treated as hung and its process
/// tree killed. Scaling a single already-decoded image is near-instant; this is generous headroom
/// for a cold disk while staying bounded, matching every other external-process call site.
const DISPLAY_THUMBNAIL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// How often the bounded wait re-checks for exit. Matches `thumbnail/temp.rs`'s generator.
const DISPLAY_THUMBNAIL_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// Upper bound on how many derivatives one call will generate.
///
/// A resolve call carries one page of the grid, so the normal miss count is a page's worth on first
/// visit and zero afterwards. The cap is what keeps a caller-supplied list from turning into an
/// unbounded run of FFmpeg invocations: entries past it are simply reported as having no derivative,
/// which the caller already handles by rendering the canonical file. Cache *hits* are not capped -
/// they are a stat each, and refusing them would make a fully warmed page fall back for no reason.
const MAX_GENERATIONS_PER_CALL: usize = 64;

/// The name a derivative lands under: the canonical thumbnail's own content hash, plus the shared
/// thumbnail container.
///
/// Pure so the addressing can be pinned without a filesystem or an FFmpeg.
fn display_thumbnail_file_name(cache_key: &str) -> String {
    format!("{cache_key}.{THUMBNAIL_OUTPUT_FORMAT}")
}

/// The cache key for a library-relative thumbnail path, or `None` when the name is not one this app
/// produced.
///
/// Every thumbnail and avatar the app writes is named `thumb_<sha256>.<ext>`
/// (`services::thumbnail::persist`), so the content hash is already in the name and the key is free
/// to compute - no re-reading the file on a cache hit, which is the point: a hit has to cost a stat,
/// not a hash of the very bytes the derivative exists to avoid decoding.
///
/// The hash is what the key is taken from rather than the whole filename, so two rows pointing at
/// the same content share one derivative exactly as they already share one canonical file. The
/// extension is deliberately dropped: it is a property of the source encoding, while the derivative
/// is always [`THUMBNAIL_OUTPUT_FORMAT`], and including it would keep two derivatives of identical
/// content if a `.png` and a `.jpg` of it ever coexisted.
///
/// A name that does not match returns `None` instead of being hashed into some other key. That is
/// the honest answer - the app cannot have written it, so it is a hand-placed or legacy file - and
/// `None` costs nothing: the caller renders the canonical file, which is what it did before this
/// module existed.
fn display_cache_key(relative_path: &str) -> Option<String> {
    let file_name = Path::new(relative_path.trim())
        .file_name()
        .and_then(|name| name.to_str())?;

    let stem = file_name.strip_prefix("thumb_")?;
    let stem = stem.split('.').next()?;

    let is_content_hash = stem.len() == 64 && stem.chars().all(|c| c.is_ascii_hexdigit());

    is_content_hash.then(|| stem.to_ascii_lowercase())
}

/// Builds the FFmpeg argv that writes the scaled copy.
///
/// `scale='min(<max>,iw)':-1` never upscales, so a source already at or under the cap is copied at
/// its own size rather than blown up - which matters because the two producers write at different
/// sizes (a yt-dlp `maxresdefault` at 1280 wide, an FFmpeg frame already capped at 640).
///
/// Extracted as a pure function, like `thumbnail::temp::build_video_thumbnail_args`, so the argv can
/// be asserted without spawning a process; a wrong filter here is otherwise only observable as a
/// blurry or oversized card on someone's machine.
fn build_display_thumbnail_args(source_path: &Path, out_path: &Path) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-i".to_string(),
        source_path.to_string_lossy().to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-vf".to_string(),
        format!("scale='min({DISPLAY_THUMBNAIL_MAX_WIDTH},iw)':-1"),
        out_path.to_string_lossy().to_string(),
    ]
}

/// Claims one slot from the per-call generation budget, or `None` when the budget is spent.
///
/// Pure, and separate from the caller, for the reason every extraction in this codebase is: the
/// branch that spends the budget can only be reached by actually running FFmpeg, so a test driving
/// `resolve_one` never gets far enough to observe the accounting - a budget that counted the wrong
/// way, or never ran out, would look identical from outside. Here both directions are one call away.
///
/// `Option<()>` rather than `bool` so the caller can write `take_generation_slot(..)?` and state the
/// decision once. An `if !slot { return None }` restates it, and a dropped `!` there is a mutant no
/// unit test can kill: both spellings return `None` unless FFmpeg actually succeeds. Removing the
/// restatement removes the mutant, which is preferable to excluding it.
///
/// The budget itself exists so a caller-supplied list cannot turn into an unbounded run of FFmpeg
/// invocations; see [`MAX_GENERATIONS_PER_CALL`].
fn take_generation_slot(generations_left: &mut usize) -> Option<()> {
    if *generations_left == 0 {
        return None;
    }

    *generations_left -= 1;
    Some(())
}

/// True when the file at `path` exists, is a regular file, and is not empty.
///
/// Used both to accept a cached derivative and to accept a freshly written one. The emptiness check
/// is what stops a run that died after creating the output from leaving a zero-byte file that every
/// later call would treat as a valid cache hit - a permanently blank card, regenerated never.
fn is_usable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() > 0)
        .unwrap_or(false)
}

/// Runs FFmpeg to produce `out_path`, bounded by [`DISPLAY_THUMBNAIL_TIMEOUT`] and killed as a
/// process tree if it overruns. Returns whether a usable file resulted.
///
/// Output is discarded rather than captured: nothing reads it, and letting FFmpeg inherit closed
/// pipes avoids the drain-two-streams machinery the paths that *do* report stderr need.
fn generate_display_thumbnail(ffmpeg: &str, source_path: &Path, out_path: &Path) -> bool {
    let mut command = std::process::Command::new(ffmpeg);
    command.args(build_display_thumbnail_args(source_path, out_path));
    command.stdout(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    hide_console(&mut command);
    // Own process group so the timeout below can tree-kill it, matching every other call site.
    configure_process_group_blocking(&mut command);

    let Ok(mut child) = command.spawn() else {
        return false;
    };

    let pid = child.id();
    let deadline = std::time::Instant::now() + DISPLAY_THUMBNAIL_TIMEOUT;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => return false,
        }

        if std::time::Instant::now() >= deadline {
            kill_process_tree_blocking(pid);
            let _ = child.wait();

            // A killed run can still have created a partial file; drop it so the next call retries
            // instead of caching a truncated image forever.
            let _ = std::fs::remove_file(out_path);
            return false;
        }

        std::thread::sleep(DISPLAY_THUMBNAIL_POLL);
    }

    if is_usable_file(out_path) {
        return true;
    }

    let _ = std::fs::remove_file(out_path);
    false
}

/// Resolves the display-sized copy of one library-relative thumbnail path, generating it if it is
/// not cached yet. `ffmpeg` is resolved once by the caller and passed in, so a page of misses does
/// not re-resolve the binary per entry.
///
/// Returns `None` on every failure, which the caller turns into "render the canonical file".
fn resolve_one(
    library_path: &str,
    relative_path: &str,
    display_dir: &Path,
    ffmpeg: Option<&str>,
    generations_left: &mut usize,
) -> Option<PathBuf> {
    let cache_key = display_cache_key(relative_path)?;
    let out_path = display_dir.join(display_thumbnail_file_name(&cache_key));

    // The hit path: a stat, and nothing else. This is the case that has to stay cheap, since it is
    // every page view after the first.
    if is_usable_file(&out_path) {
        return Some(out_path);
    }

    // Only now does the source have to be located and validated, so a warmed cache never pays for
    // the containment check either.
    ensure_relative_path_in_managed_dir(relative_path, LIBRARY_DIR_THUMBNAILS).ok()?;
    let source_path = absolute_path_from_relative(Path::new(library_path), relative_path).ok()?;

    if !is_usable_file(&source_path) {
        return None;
    }

    take_generation_slot(generations_left)?;

    generate_display_thumbnail(ffmpeg?, &source_path, &out_path).then_some(out_path)
}

/// Resolves display-sized copies for a page of thumbnails, in the order given.
///
/// Each entry is `Some(absolute path to the derivative)` or `None`, and `None` is a normal answer,
/// never an error: the caller renders the canonical file for it. The whole call likewise returns
/// `Ok` with every entry `None` rather than failing when the cache directory or FFmpeg cannot be
/// resolved - the grid must render either way, and a thumbnail cache is not worth an error modal.
///
/// `library_path` is the caller's, and is verified by the command layer
/// (`verify_library_path_then_blocking`) before this runs, exactly like every other library read.
pub fn resolve_display_thumbnails_sync(
    app: &AppHandle,
    library_path: &str,
    relative_paths: &[String],
) -> AppResult<Vec<Option<String>>> {
    let Ok(display_dir) = thumb_display_dir(app) else {
        logger::warn(
            "thumbnail_display",
            "could not resolve the display thumbnail cache directory; serving the stored thumbnails",
        );

        return Ok(vec![None; relative_paths.len()]);
    };

    // Resolved once for the whole page, and only lazily needed: a fully cached page never asks for
    // it, so a machine without FFmpeg still gets its derivatives served (it just cannot make new
    // ones). `resolve_one` treats a missing binary as "no derivative", not as an error.
    let ffmpeg = resolve_ffmpeg_binary(app).ok();
    let mut generations_left = MAX_GENERATIONS_PER_CALL;

    let resolved = relative_paths
        .iter()
        .map(|relative_path| {
            resolve_one(
                library_path,
                relative_path,
                &display_dir,
                ffmpeg.as_deref(),
                &mut generations_left,
            )
            .map(|path| path.to_string_lossy().to_string())
        })
        .collect();

    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_cache_key_takes_the_content_hash_out_of_the_stored_name() {
        // The whole reason a hit is cheap: the hash is already in the name the app wrote, so the key
        // costs a string split rather than a read of the very file the derivative exists to avoid
        // decoding.
        let hash = "a".repeat(64);

        assert_eq!(
            display_cache_key(&format!("thumbnails/thumb_{hash}.jpg")),
            Some(hash.clone())
        );

        // The extension is not part of the key: the derivative is always THUMBNAIL_OUTPUT_FORMAT,
        // so the same content stored under two source encodings must resolve to one derivative
        // rather than two copies of an identical image.
        assert_eq!(
            display_cache_key(&format!("thumbnails/thumb_{hash}.png")),
            display_cache_key(&format!("thumbnails/thumb_{hash}.jpg"))
        );

        // Upper-case hex normalizes, so a name that differs only in case cannot take a second slot.
        assert_eq!(
            display_cache_key(&format!("thumbnails/thumb_{}.jpg", hash.to_uppercase())),
            Some(hash)
        );
    }

    #[test]
    fn display_cache_key_refuses_a_name_this_app_did_not_write() {
        // Refusing is what keeps the cache addressed by content. A name without the app's prefix or
        // without a full-length hash cannot be assumed to identify its own bytes, so it gets no
        // derivative and the caller renders the canonical file - which is what it did before this
        // module existed, so `None` costs nothing.
        for value in [
            "thumbnails/photo.jpg",                              // not written by this app
            "thumbnails/thumb_short.jpg",                        // not a hash
            &format!("thumbnails/thumb_{}.jpg", "a".repeat(63)), // one hex digit short
            &format!("thumbnails/thumb_{}.jpg", "a".repeat(65)), // one too many
            &format!("thumbnails/thumb_{}.jpg", "g".repeat(64)), // not hex
            "",
        ] {
            assert_eq!(display_cache_key(value), None, "should refuse: {value}");
        }
    }

    #[test]
    fn display_cache_key_ignores_the_directory_it_came_from() {
        // An avatar and a video thumbnail both live under thumbnails/ and are both content
        // addressed, so they share the cache the same way they already share canonical files.
        let hash = "b".repeat(64);

        assert_eq!(
            display_cache_key(&format!("thumbnails/thumb_{hash}.jpg")),
            display_cache_key(&format!("thumb_{hash}.jpg"))
        );
    }

    #[test]
    fn display_thumbnail_file_name_uses_the_shared_thumbnail_format() {
        // ffmpeg picks its encoder from the output extension, so the name is what decides the bytes.
        let name = display_thumbnail_file_name("abc");

        assert_eq!(name, format!("abc.{THUMBNAIL_OUTPUT_FORMAT}"));
    }

    #[test]
    fn display_thumbnail_args_scale_down_without_ever_upscaling() {
        let args =
            build_display_thumbnail_args(Path::new("/lib/thumb.jpg"), Path::new("/cache/out.jpg"));

        assert_eq!(
            args,
            vec![
                "-y",
                "-i",
                "/lib/thumb.jpg",
                "-frames:v",
                "1",
                "-vf",
                &format!("scale='min({DISPLAY_THUMBNAIL_MAX_WIDTH},iw)':-1"),
                "/cache/out.jpg",
            ]
        );

        // `min(max,iw)` and not a bare width: the two producers write at different sizes (a yt-dlp
        // maxresdefault at 1280 wide, an FFmpeg frame already capped at 640), and upscaling the
        // smaller one would cost disk and decode time to make it blurrier.
        let filter = &args[6];
        assert!(
            filter.contains("min("),
            "the filter must not upscale: {filter}"
        );
    }

    #[test]
    fn the_source_path_is_passed_as_a_single_argument() {
        // A path with spaces has to stay one argv entry. The commands are spawned without a shell,
        // so this is already true by construction; asserting it is what stops a future rewrite from
        // joining the argv into a string.
        let args = build_display_thumbnail_args(
            Path::new("/lib/My Library/thumb.jpg"),
            Path::new("/cache/out dir/out.jpg"),
        );

        assert!(args.contains(&"/lib/My Library/thumb.jpg".to_string()));
        assert!(args.contains(&"/cache/out dir/out.jpg".to_string()));
    }

    #[test]
    fn the_generation_budget_is_spent_one_slot_at_a_time_and_then_refuses() {
        // Both directions of the accounting, which the caller cannot exercise: reaching the spend
        // needs a real FFmpeg run, so a budget that counted upward, divided instead of decremented,
        // or never hit its floor would be invisible from `resolve_one`.
        let mut generations_left = 2usize;

        assert_eq!(take_generation_slot(&mut generations_left), Some(()));
        assert_eq!(generations_left, 1, "a slot must cost exactly one");

        assert_eq!(take_generation_slot(&mut generations_left), Some(()));
        assert_eq!(generations_left, 0);

        // Exhausted: refuses without wrapping the counter, which on a usize would panic in debug
        // and hand out a near-infinite budget in release.
        assert_eq!(take_generation_slot(&mut generations_left), None);
        assert_eq!(generations_left, 0);
    }

    #[test]
    fn a_zero_budget_refuses_before_it_can_underflow() {
        let mut generations_left = 0usize;

        assert_eq!(take_generation_slot(&mut generations_left), None);
        assert_eq!(generations_left, 0);
    }

    #[test]
    fn is_usable_file_rejects_a_zero_byte_cache_entry() {
        // The case this exists for: a generation killed after creating its output leaves an empty
        // file. Treating that as a hit would cache a permanently blank card that nothing ever
        // regenerates.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-display-thumb-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let empty = dir.join("empty.jpg");
        std::fs::write(&empty, b"").unwrap();
        assert!(!is_usable_file(&empty));

        let written = dir.join("written.jpg");
        std::fs::write(&written, b"\xff\xd8\xff").unwrap();
        assert!(is_usable_file(&written));

        assert!(!is_usable_file(&dir), "a directory is not a usable file");
        assert!(!is_usable_file(&dir.join("missing.jpg")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refused_name_never_consumes_a_generation_slot() {
        // The budget bounds FFmpeg runs, so an entry that cannot have one must not spend it.
        // Otherwise a page of hand-placed names would exhaust the budget and starve the real
        // thumbnails behind them of a derivative.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-display-budget-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let mut generations_left = 1usize;
        let resolved = resolve_one(
            "/library",
            "thumbnails/not-ours.jpg",
            &dir,
            Some("ffmpeg"),
            &mut generations_left,
        );

        assert_eq!(resolved, None);
        assert_eq!(generations_left, 1, "a refused name must not spend budget");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cached_derivative_is_returned_without_touching_the_library() {
        // The hit path must not need the library at all: no containment check, no source stat, no
        // FFmpeg. Passing a library path that does not exist and an ffmpeg that could never run is
        // what proves it - if either were consulted, this would return None.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-display-hit-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let hash = "c".repeat(64);
        let cached = dir.join(display_thumbnail_file_name(&hash));
        std::fs::write(&cached, b"\xff\xd8\xff").unwrap();

        let mut generations_left = 0usize;
        let resolved = resolve_one(
            "/no/such/library",
            &format!("thumbnails/thumb_{hash}.jpg"),
            &dir,
            None,
            &mut generations_left,
        );

        assert_eq!(resolved, Some(cached));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_source_yields_no_derivative_rather_than_an_error() {
        // A row can point at a thumbnail that is no longer on disk (moved or deleted outside the
        // app, which Diagnostics reports). That has to read as "no derivative" so the card falls
        // back to its existing missing-thumbnail handling, not as a failure of the whole page.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-display-miss-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let mut generations_left = 4usize;
        let resolved = resolve_one(
            &dir.to_string_lossy(),
            &format!("thumbnails/thumb_{}.jpg", "d".repeat(64)),
            &dir,
            Some("ffmpeg"),
            &mut generations_left,
        );

        assert_eq!(resolved, None);
        assert_eq!(
            generations_left, 4,
            "a source that is not there must not spend budget either"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
