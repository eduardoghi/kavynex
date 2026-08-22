//! A cache of display-sized copies of the library's thumbnails.
//!
//! The library stores a thumbnail at whatever size it arrived: yt-dlp's `maxresdefault` is
//! 1280x720, and an FFmpeg frame is capped at 640 wide. The grid draws them into a card a few
//! hundred pixels across, and a webview decodes an image at its natural size (`width * height * 4`
//! bytes of bitmap), regardless of how well the file is compressed. So the grid pays for the full
//! 1280x720 decode of every visible card, and pays it again whenever the webview evicts and
//! re-decodes on a scroll back. Virtualization does not help: it bounds how many cards are in the
//! DOM, not how large each one's image is.
//!
//! Switching the stored thumbnails to JPEG (see [`crate::constants::THUMBNAIL_OUTPUT_FORMAT`])
//! addressed disk and I/O and could not address this (compression does not change a decoded
//! bitmap), and it only applied to files written after it landed, because names are
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
//!   (`services::temp_cleanup`), and a missing derivative regenerates on demand, so losing the whole
//!   directory costs one re-encode and never a user's data.
//! - **It is retroactive.** A thumbnail that has been in the library for a year gets a derivative
//!   the first time it is asked for, which is what the format switch could not do.
//! - **It fails open.** Every failure path (an unreadable source, a missing FFmpeg, a refused
//!   cache directory), answers that entry with no derivative, and the caller renders the canonical
//!   file exactly as before. A slow card is better than a blank one.
//!
//! What an answer does carry, on top of the derivative or its absence, is whether asking again
//! could change it ([`DisplayThumbnail`]). That is not a detail of the encoding: the caller re-asks
//! about every path it has not settled, so conflating "no slots left this call" with "this path can
//! never resolve" made a permanently unresolvable path ride along on every request for the rest of
//! the session.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use tauri::{AppHandle, Runtime};
use tokio::sync::{Semaphore, SemaphorePermit};

use crate::constants::{
    DISPLAY_THUMBNAIL_MAX_WIDTH, LIBRARY_DIR_THUMBNAILS, THUMBNAIL_OUTPUT_FORMAT,
};
use crate::services::binaries::resolve_ffmpeg_binary;
use crate::services::logger;
use crate::services::temp_paths::thumb_display_dir;
use crate::utils::path::{
    absolute_path_from_relative, ensure_relative_path_in_managed_dir, ManagedSubtree,
};
use crate::utils::process::{
    configure_process_group_blocking, hide_console, kill_process_tree_blocking,
};
use crate::AppResult;

/// How long one derivative generation may run before FFmpeg is treated as hung and its process
/// tree killed. Scaling a single already-decoded image is near-instant, so this is generous
/// headroom for a cold disk while staying bounded, matching every other external-process call site.
const DISPLAY_THUMBNAIL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// How often the bounded wait re-checks for exit. Matches `thumbnail/temp.rs`'s generator.
const DISPLAY_THUMBNAIL_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// How long one resolve call may spend generating before it stops starting new FFmpeg runs.
///
/// [`DISPLAY_THUMBNAIL_TIMEOUT`] bounds *one* child. Nothing bounded a page of them. The two
/// multiply: at [`MAX_GENERATIONS_PER_CALL`] generations each allowed the full per-process timeout,
/// a page where FFmpeg reproducibly hangs could hold one blocking-pool thread for over half an hour,
/// and the caller cannot see it or cancel it. The request is fire-and-forget, and its failure path
/// only logs. Every other `run_blocking` caller (import, hashing, cleanup, the other library reads)
/// competes for that pool, so the cost is not confined to thumbnails.
///
/// Sized so a legitimate call never meets it, which is the constraint that matters and the one that
/// is easy to get wrong. A full page of 100 real generations runs a few seconds. Even at 300ms
/// each (a cold disk on a slow machine) it is 30s. Cutting close to that would recreate the bug
/// [`MAX_GENERATIONS_PER_CALL`] was raised from 64 to fix: the tail of a first-visited page would
/// come back unresolved, and a channel that fits in one page has no later append to trigger the
/// retry, so those cards would keep decoding the stored file for the session. This is four times a
/// slow full page, and still turns the pathological case from ~33 minutes into two.
const RESOLVE_CALL_BUDGET: std::time::Duration = std::time::Duration::from_secs(120);

/// Upper bound on how many derivatives one call will generate.
///
/// A resolve call carries one page of the grid, so the normal miss count is a page's worth on first
/// visit and zero afterwards. The cap is what keeps a caller-supplied list from turning into an
/// unbounded run of FFmpeg invocations: entries past it are simply reported as having no derivative,
/// which the caller already handles by rendering the canonical file. Cache *hits* are not capped.
/// they are a stat each, and refusing them would make a fully warmed page fall back for no reason.
///
/// Sized to a **full** page (`shared/media-page-size.json`, pinned by
/// `the_generation_budget_covers_a_full_page_of_the_grid` below), which it was not: at 64 against a
/// page of 100, the first visit to a channel generated 64 derivatives and had nothing left for the
/// remaining 36. That is not the self-correcting miss the comment above describes, because the
/// caller only re-asks when its item list changes: a channel that fits in one page (`hasMore` false)
/// has nothing left to trigger a retry, so those 36 cards kept decoding the full-resolution stored
/// file for the rest of the session. The exact cost this module exists to remove.
const MAX_GENERATIONS_PER_CALL: usize = 100;

/// Upper bound on how many entries one call will consider at all.
///
/// [`MAX_GENERATIONS_PER_CALL`] bounds the expensive half (how many FFmpeg runs a call may start),
/// and says nothing about the cheap half, which is not free at library scale: every entry costs a
/// `display_cache_key` and a `stat` whether or not it can be generated, all of it on one
/// blocking-pool thread. This is the bound on that, and it is the same bound every other command
/// taking a collection over IPC already declares (`MAX_MEDIA_PAGE_LIMIT`,
/// `MAX_MEDIA_COMMENTS_LOADED`, `MAX_SEARCH_TERM_CHARS`, `MAX_RUN_ID_LEN`): the backend is the trust
/// boundary, so it states its own limit rather than inheriting whatever the caller sends.
///
/// A page of the grid is a hundred rows (`shared/media-page-size.json`), so this is generous for
/// every legitimate call. Entries past it answer [`DisplayThumbnail::BudgetSpent`]. The caller
/// renders the stored thumbnail for them, and asks again, which is right: nothing was decided about
/// those paths, so recording them as final would strand cards that a smaller later request would
/// have resolved.
const MAX_RESOLVED_PER_CALL: usize = 512;

/// Ceiling on the total size of the derivative cache directory.
///
/// A derivative is capped at [`DISPLAY_THUMBNAIL_MAX_WIDTH`] wide and JPEG-encoded, so it runs tens
/// of kilobytes, and this holds a few thousand of them, which is more than a session draws. It
/// exists because the directory otherwise has no bound at all. A derivative is never deleted when
/// its media is, since nothing in the database refers to one (see the module docs).
///
/// **Enforced by the startup sweep** (`services::temp_cleanup::cleanup_stale_temp_files_sync`), not on
/// write: a session that draws more than this grows past it and is trimmed back on the next launch.
/// That is deliberate rather than an oversight, and said here because "ceiling" otherwise reads
/// as a continuous invariant. Checking it per generated entry would mean summing the directory on
/// each write, and keeping the write path cheap is the whole shape of this module. A cache *hit* is
/// one `stat` ([`display_cache_key`]) precisely so the grid pays nothing for a warmed page. The
/// overshoot is bounded by what one session can draw and costs disk in a directory that is
/// disposable by construction, which is the cheaper side of the trade.
const DISPLAY_CACHE_MAX_BYTES: u64 = 200 * 1024 * 1024;

/// Admits one resolve call at a time onto the blocking pool.
///
/// [`RESOLVE_CALL_BUDGET`] and [`MAX_GENERATIONS_PER_CALL`] bound what *one* call may do. Neither
/// bounds how many calls are doing it. Nothing else does either, because this request is
/// fire-and-forget: `useDisplayThumbnails` asks once per page of the grid and only discards the
/// result it no longer wants, so a user scrolling a large channel on a machine where FFmpeg
/// reproducibly hangs stacks one two-minute occupant per page onto the pool that the import, the
/// hashing, the cleanup and every other library read share. The cost of that is not confined to
/// thumbnails, which is the whole reason this is here.
static RESOLVE_SLOT: Semaphore = Semaphore::const_new(1);

/// Claims the single resolve slot, or `None` when another resolve already holds it.
///
/// Deliberately `try_acquire` rather than an await: a queued page is worse than a refused one here.
/// By the time a waiting call ran, the user would likely have scrolled past the rows it was asked
/// about, so it would occupy the pool to produce derivatives for cards nobody is looking at, ahead
/// of the request for the ones they are. A refusal costs nothing instead, because the caller already
/// knows what to do with it (see [`all_retryable`]).
///
/// Both failure kinds collapse to `None` on purpose. `NoPermits` is the case this exists for, and
/// `Closed` cannot happen (a `static` semaphore is never closed), but if it somehow did, answering
/// "no slot" degrades to serving the stored thumbnails, which is this module's declared fallback.
pub(crate) fn try_reserve_resolve_slot() -> Option<SemaphorePermit<'static>> {
    RESOLVE_SLOT.try_acquire().ok()
}

/// The answer for a call that was refused a slot: every entry retryable, nothing decided.
///
/// [`DisplayThumbnail::BudgetSpent`] and not `Unavailable`, and the distinction is exactly the one
/// that enum exists for. Nothing was learned about these paths (the sources may be there, FFmpeg
/// may be present, the derivatives may even be cached), so recording them as final would strand
/// cards a later call could have resolved. `BudgetSpent` is already what the caller re-asks about,
/// and a call refused a slot is a per-call condition in exactly the sense that variant means.
///
/// `count` is bounded by [`capped_call_length`] rather than taken from the caller. This exit was the
/// one place in the module that inherited a caller-supplied number instead of stating its own,
/// which is the rule [`MAX_RESOLVED_PER_CALL`] exists to apply, and it is safe to answer short
/// here because a missing answer and a `BudgetSpent` one mean the same thing to the caller: it
/// reads the response by position and leaves an unanswered tail unsettled, which is precisely
/// "ask again". Nothing is lost by the truncation and nothing is decided by it.
pub(crate) fn all_retryable(count: usize) -> Vec<DisplayThumbnail> {
    vec![DisplayThumbnail::BudgetSpent; capped_call_length(count)]
}

/// How many entries of a request of `requested` paths this module will speak about at all.
///
/// The single place that knows [`MAX_RESOLVED_PER_CALL`], so the two exits that apply it (the
/// resolve itself, through [`within_call_ceiling`], and the refused-slot answer above), cannot
/// disagree about where the ceiling is.
pub(crate) fn capped_call_length(requested: usize) -> usize {
    requested.min(MAX_RESOLVED_PER_CALL)
}

/// What one requested thumbnail got, and (when it got nothing), whether asking again could ever
/// change that.
///
/// This distinction is the whole reason the answer is not an `Option<String>`. There are five ways
/// an entry ends up without a derivative and only one of them is worth retrying, but the caller
/// could not tell them apart: it received `null` for a page whose generation budget ran out and
/// `null` for a name this app did not write, so it had to pick one behavior for both. It picked
/// retry, which is correct for the first and wrong for every other, and being wrong there is not
/// harmless. The caller asks about every loaded row, so a path that can never be resolved comes back
/// on every page append, forever: on a machine without FFmpeg, or a library holding rows written
/// before thumbnails were content-addressed, that restores exactly the quadratic growth
/// `useDisplayThumbnails` was built to remove, and past
/// [`MAX_RESOLVED_PER_CALL`] it also logs a truncation warning per page whose text says no
/// legitimate flow reaches it.
///
/// So the backend states which it is, because the backend is the only side that knows. Only
/// [`DisplayThumbnail::BudgetSpent`] means "ask again". Everything else is final for this library.
///
/// The uncertain cases resolve to [`DisplayThumbnail::Unavailable`] deliberately. A source that is
/// gone might come back, and an FFmpeg run that failed might succeed on a retry, but the cost of
/// treating those as permanent is one session of drawing the stored thumbnail, which is the fallback
/// this whole module already declares acceptable, while the cost of treating them as retryable is
/// the unbounded re-asking above. A fresh launch retries all of them anyway, since the cache is
/// consulted by content hash and nothing is remembered across sessions.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/types/generated/")]
pub enum DisplayThumbnail {
    /// The absolute path of the display-sized copy.
    Resolved { path: String },
    /// No derivative *this call*: the per-call generation budget was already spent, or the entry
    /// fell past the per-call ceiling. The only answer worth asking about again.
    BudgetSpent,
    /// No derivative, and no later call will produce one for this path in this library.
    Unavailable,
}

impl DisplayThumbnail {
    fn resolved(path: PathBuf) -> Self {
        Self::Resolved {
            path: path.to_string_lossy().to_string(),
        }
    }
}

/// One cached derivative, as [`plan_display_cache_eviction`] sees it. Carries only what the decision
/// reads, so that decision can be made without a filesystem.
pub(crate) struct CachedDerivative {
    pub(crate) path: PathBuf,
    pub(crate) size_bytes: u64,
    pub(crate) modified_at: SystemTime,
}

/// Chooses which derivatives to drop so the cache fits under `max_bytes`, oldest first.
///
/// This exists because the cache was previously swept by the same age rule as its neighbours under
/// the app cache directory, and that rule is wrong for it. `thumbs-temp/`, `yt-dlp-temp/` and
/// `yt-dlp-thumb-temp/` hold scratch from an operation that finished, so an old entry there is
/// garbage by definition. A derivative is not: regenerating one costs an FFmpeg process, and reading
/// a cached one is a `stat` that renews nothing, so an age sweep discarded the thumbnails the grid
/// draws every day at exactly the same rate as the ones nothing had looked at since they were
/// written. The whole cache therefore emptied every seven days and came back as a burst of FFmpeg
/// runs on the next scroll, which is most of the cost the cache exists to remove.
///
/// Bounding total size instead means a cache that fits is never touched, whatever its age, and a
/// cache that does not is trimmed to fit rather than emptied.
///
/// Ordering is by write time, so this is FIFO rather than LRU. Making it a true LRU would need a
/// write on every cache *hit* to renew the entry, and a hit costing a write instead of a `stat` is
/// precisely what [`display_cache_key`] is shaped to avoid. FIFO is the right trade here: it only
/// decides which entries leave once the budget is already exceeded, where the previous rule decided
/// that every entry leaves regardless.
///
/// Pure, and separate from the sweep that calls it, for the reason every extraction in this module
/// is: the decision in front of files on the user's disk should be a function a test can hand exact
/// inputs to, not a comparison buried in a `read_dir` loop.
pub(crate) fn plan_display_cache_eviction(
    mut entries: Vec<CachedDerivative>,
    max_bytes: u64,
) -> Vec<PathBuf> {
    let total_bytes: u64 = entries
        .iter()
        .map(|entry| entry.size_bytes)
        .fold(0u64, u64::saturating_add);

    if total_bytes <= max_bytes {
        return Vec::new();
    }

    entries.sort_by_key(|entry| entry.modified_at);

    let mut over_budget = total_bytes - max_bytes;
    let mut evicted = Vec::new();

    for entry in entries {
        if over_budget == 0 {
            break;
        }

        over_budget = over_budget.saturating_sub(entry.size_bytes);
        evicted.push(entry.path);
    }

    evicted
}

/// The cache's own size budget, for the startup sweep that enforces it (`services::temp_cleanup`).
pub(crate) fn display_cache_max_bytes() -> u64 {
    DISPLAY_CACHE_MAX_BYTES
}

/// The prefix of `relative_paths` one call will resolve, bounded by [`MAX_RESOLVED_PER_CALL`].
///
/// Pure over the slice so both directions of the ceiling are one call from a test, but the entry
/// point that applies it is `AppHandle`-bound and cannot be driven by one.
pub(crate) fn within_call_ceiling(relative_paths: &[String]) -> &[String] {
    &relative_paths[..capped_call_length(relative_paths.len())]
}

/// True when the per-call ceiling dropped entries the caller asked about.
///
/// Its own predicate for the reason every other decision in this module is one, and this time the
/// reason is not a prediction: the weekly mutation run reported this comparison missed while it was
/// still inline in [`resolve_display_thumbnails_sync`], which is `AppHandle`-bound and therefore
/// unreachable from a test. Both replacements matter and neither is loud. A `>` silences the warning
/// on a genuinely truncated call (the case it exists to announce), and a `<=` fires it on every
/// exact-fit page, telling whoever reads the log that a caller asked for more than a page when
/// nothing did.
pub(crate) fn request_was_truncated(considered: usize, requested: usize) -> bool {
    considered < requested
}

/// The name a derivative lands under: the canonical thumbnail's own content hash, the width it was
/// scaled to, and the shared thumbnail container.
///
/// The width is part of the name because it is part of what the derivative *is*, and leaving it out
/// made [`DISPLAY_THUMBNAIL_MAX_WIDTH`] a constant that could not be changed. Nothing revalidates a
/// cached file's dimensions ([`is_usable_file`] asks only whether it exists and is non-empty), so a
/// name of `<hash>.jpg` alone kept serving 640-wide derivatives forever after the constant moved,
/// leaving a library holding two sizes with no way to tell which was which. Naming the width makes a
/// change to it self-invalidating, exactly as [`THUMBNAIL_OUTPUT_FORMAT`] already is by virtue of
/// being the extension: derivatives at the old width stop being addressed, and the size sweep
/// reclaims them as the disposable files they are.
///
/// Pure so the addressing can be pinned without a filesystem or an FFmpeg.
fn display_thumbnail_file_name(cache_key: &str) -> String {
    format!("{cache_key}-w{DISPLAY_THUMBNAIL_MAX_WIDTH}.{THUMBNAIL_OUTPUT_FORMAT}")
}

/// The cache key for a library-relative thumbnail path, or `None` when the name is not one this app
/// produced.
///
/// Every thumbnail and avatar the app writes is named `thumb_<sha256>.<ext>`
/// (`services::thumbnail::persist`), so the content hash is already in the name and the key is free
/// to compute. No re-reading the file on a cache hit, which is the point: a hit has to cost a stat,
/// not a hash of the very bytes the derivative exists to avoid decoding.
///
/// The hash is what the key is taken from rather than the whole filename, so two rows pointing at
/// the same content share one derivative exactly as they already share one canonical file. The
/// extension is deliberately dropped: it is a property of the source encoding, while the derivative
/// is always [`THUMBNAIL_OUTPUT_FORMAT`], and including it would keep two derivatives of identical
/// content if a `.png` and a `.jpg` of it ever coexisted.
///
/// A name that does not match returns `None` instead of being hashed into some other key. That is
/// the honest answer (the app cannot have written it, so it is a hand-placed or legacy file), and
/// `None` costs nothing: the caller renders the canonical file, which is what it did before this
/// module existed.
/// Where the derivative of a stored, library-relative thumbnail lives, or `None` when the name is
/// not one this app produced (see [`display_cache_key`]).
///
/// The single spelling of the mapping, so the two callers cannot disagree about it: the resolve
/// path uses it to find or write a derivative, and `library::cleanup` uses it to remove one whose
/// canonical thumbnail was just unlinked. That second caller is the reason this is a function
/// rather than two lines inlined at the resolve site. It has no business knowing that a derivative
/// is named from a content hash plus a width.
///
/// It also means the cleanup needs no reference counting of its own. A derivative is addressed *by*
/// the canonical thumbnail's content hash, so two rows sharing a thumbnail share its derivative
/// exactly as they share the file. The count the cleanup already ran before unlinking the canonical
/// file is therefore the same count, and there is nothing further to decide.
pub(crate) fn display_derivative_path(display_dir: &Path, relative_path: &str) -> Option<PathBuf> {
    let cache_key = display_cache_key(relative_path)?;

    Some(display_dir.join(display_thumbnail_file_name(&cache_key)))
}

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
/// its own size rather than blown up, which matters because the two producers write at different
/// sizes (a yt-dlp `maxresdefault` at 1280 wide, an FFmpeg frame already capped at 640).
///
/// Extracted as a pure function, like `thumbnail::temp::build_video_thumbnail_args`, so the argv can
/// be asserted without spawning a process. A wrong filter here is otherwise only observable as a
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
/// `resolve_one` never gets far enough to observe the accounting. A budget that counted the wrong
/// way, or never ran out, would look identical from outside. Here both directions are one call away.
///
/// `Option<()>` rather than `bool` so the caller can write `take_generation_slot(..)?` and state the
/// decision once. An `if !slot { return None }` restates it, and a dropped `!` there is a mutant no
/// unit test can kill: both spellings return `None` unless FFmpeg actually succeeds. Removing the
/// restatement removes the mutant, which is preferable to excluding it.
///
/// The budget itself exists so a caller-supplied list cannot turn into an unbounded run of FFmpeg
/// invocations. See [`MAX_GENERATIONS_PER_CALL`].
fn take_generation_slot(generations_left: &mut usize) -> Option<()> {
    if *generations_left == 0 {
        return None;
    }

    *generations_left -= 1;
    Some(())
}

/// True once this call has spent its wall-clock budget and must stop starting FFmpeg runs.
///
/// Takes `now` rather than reading the clock, for the same reason `duration_is_recent` in
/// `db_backup` does: a bound whose only observable effect is "some later entry got nothing" cannot
/// be pinned at its boundary by a test that has to wait for real time to pass. Here both sides of
/// the comparison are one call away, which is also what kills the `>=` mutants. A `>` would let a
/// call that has exactly spent its budget start one more child.
///
/// `saturating_duration_since` rather than the subtracting form: `Instant` is monotonic per the
/// standard library, but the arithmetic is on values this function is handed, and a bound in front
/// of a process spawn should not be able to panic on an argument.
fn call_budget_spent(
    started_at: std::time::Instant,
    now: std::time::Instant,
    budget: std::time::Duration,
) -> bool {
    now.saturating_duration_since(started_at) >= budget
}

/// True when the file at `path` exists, is a regular file, and is not empty.
///
/// Used both to accept a cached derivative and to accept a freshly written one. The emptiness check
/// is what stops a run that died after creating the output from leaving a zero-byte file that every
/// later call would treat as a valid cache hit. A permanently blank card, regenerated never.
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

            // A killed run can still have created a partial file. Drop it so the next call retries
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
/// Never fails: every outcome is a [`DisplayThumbnail`], and the caller turns anything that is not
/// `Resolved` into "render the canonical file". Which variant it is decides only whether the caller
/// asks about this path again.
fn resolve_one(
    library_path: &str,
    relative_path: &str,
    display_dir: &Path,
    ffmpeg: Option<&str>,
    generations_left: &mut usize,
    started_at: std::time::Instant,
) -> DisplayThumbnail {
    // A name this app did not write. Permanent: the name comes off the row and does not change.
    let Some(out_path) = display_derivative_path(display_dir, relative_path) else {
        return DisplayThumbnail::Unavailable;
    };

    // The hit path: a stat, and nothing else. This is the case that has to stay cheap, since it is
    // every page view after the first.
    if is_usable_file(&out_path) {
        return DisplayThumbnail::resolved(out_path);
    }

    // Only now does the source have to be located and validated, so a warmed cache never pays for
    // the containment check either. Both refusals are permanent. A path outside `thumbnails/`, or
    // one that will not resolve inside the library, is a property of the stored value.
    if ensure_relative_path_in_managed_dir(relative_path, LIBRARY_DIR_THUMBNAILS).is_err() {
        return DisplayThumbnail::Unavailable;
    }

    let Ok(source_path) = absolute_path_from_relative(
        Path::new(library_path),
        relative_path,
        ManagedSubtree::Thumbnails,
    ) else {
        return DisplayThumbnail::Unavailable;
    };

    if !is_usable_file(&source_path) {
        return DisplayThumbnail::Unavailable;
    }

    // The resolution above is lexical. A symlink planted under `thumbnails/` would otherwise have
    // its target handed to FFmpeg, and the derivative written into `thumb-display/`, which is one
    // of the two cache directories the webview is authorized to read. Every directory walk in the
    // library family refuses to follow a symlink; this single-path reader applies the same rule.
    // Permanent, like the other refusals here: it is a property of what sits at the stored path.
    if crate::services::filesystem::path_is_symlink(&source_path) {
        return DisplayThumbnail::Unavailable;
    }

    // Checked before the budget rather than after it. Without FFmpeg no entry in this call can
    // produce anything, so spending a slot to discover that once per entry burns the whole budget
    // on nothing and starves the entries behind it, which mattered less when every miss was
    // re-asked anyway, and matters now that a miss is final.
    let Some(ffmpeg) = ffmpeg else {
        return DisplayThumbnail::Unavailable;
    };

    // Two independent bounds on the same expensive step, and both answer BudgetSpent: each is a
    // property of *this call* rather than of the path, so a later call can still resolve it. The
    // clock is checked first so a call that is already over time does not spend a slot to discover
    // that. The slot would be wasted rather than merely accounted for.
    //
    // Neither bound gates the cache hit above. A hit is one stat, and refusing it would make a fully
    // warmed page fall back to the stored file for no reason, which is the same reasoning
    // MAX_GENERATIONS_PER_CALL already states.
    if call_budget_spent(started_at, std::time::Instant::now(), RESOLVE_CALL_BUDGET) {
        return DisplayThumbnail::BudgetSpent;
    }

    if take_generation_slot(generations_left).is_none() {
        return DisplayThumbnail::BudgetSpent;
    }

    if generate_display_thumbnail(ffmpeg, &source_path, &out_path) {
        DisplayThumbnail::resolved(out_path)
    } else {
        DisplayThumbnail::Unavailable
    }
}

/// Resolves display-sized copies for a page of thumbnails, in the order given.
///
/// Each entry is a [`DisplayThumbnail`] for the requested path at the same index, and anything other
/// than `Resolved` is a normal answer rather than an error: the caller renders the canonical file for
/// it. The whole call likewise returns `Ok` with nothing resolved rather than failing when the cache
/// directory or FFmpeg cannot be resolved. The grid must render either way, and a thumbnail cache is
/// not worth an error modal.
///
/// The returned vector is always as long as `relative_paths`, because the caller reads it by
/// position. Entries the per-call ceiling ([`MAX_RESOLVED_PER_CALL`]) excluded are `BudgetSpent`
/// rather than `Unavailable`: nothing was decided about them, so the caller should ask again.
///
/// `library_path` is the caller's, and is verified by the command layer
/// (`verify_library_path_then_blocking`) before this runs, exactly like every other library read.
pub fn resolve_display_thumbnails_sync<R: Runtime>(
    app: &AppHandle<R>,
    library_path: &str,
    relative_paths: &[String],
) -> AppResult<Vec<DisplayThumbnail>> {
    let Ok(display_dir) = thumb_display_dir(app) else {
        logger::warn(
            "thumbnail_display",
            "could not resolve the display thumbnail cache directory, serving the stored thumbnails",
        );

        // Unavailable rather than BudgetSpent: a cache directory that cannot be resolved will not
        // resolve on the next page either, so inviting the caller to re-ask would put this warning
        // in the log once per page for the rest of the session.
        return Ok(vec![DisplayThumbnail::Unavailable; relative_paths.len()]);
    };

    let considered = within_call_ceiling(relative_paths);

    // A truncated call means the caller asked about more than a page, which no legitimate flow does,
    // so say so once rather than capping silently. A page of cards quietly falling back to the
    // stored file is otherwise indistinguishable from a machine with no FFmpeg.
    if request_was_truncated(considered.len(), relative_paths.len()) {
        logger::warn(
            "thumbnail_display",
            format!(
                "a display thumbnail request named {} paths, resolving the first {} and serving the \
                 stored thumbnails for the rest",
                relative_paths.len(),
                considered.len()
            ),
        );
    }

    // Resolved once for the whole page, and only lazily needed: a fully cached page never asks for
    // it, so a machine without FFmpeg still gets its derivatives served (it just cannot make new
    // ones). `resolve_one` treats a missing binary as "no derivative", not as an error.
    let ffmpeg = resolve_ffmpeg_binary(app).ok();
    let mut generations_left = MAX_GENERATIONS_PER_CALL;

    // Pinned once, here, so every entry measures against the start of the call rather than against
    // whenever it happened to be reached. Reading it per entry would make the bound a per-entry
    // timeout, which is what DISPLAY_THUMBNAIL_TIMEOUT already is.
    let started_at = std::time::Instant::now();

    let mut resolved: Vec<DisplayThumbnail> = considered
        .iter()
        .map(|relative_path| {
            resolve_one(
                library_path,
                relative_path,
                &display_dir,
                ffmpeg.as_deref(),
                &mut generations_left,
                started_at,
            )
        })
        .collect();

    // One line per call, not per entry. Reaching the budget means FFmpeg is taking far longer than
    // scaling an image should (a hung binary, a failing disk), and it should be said once,
    // because the symptom the user sees is only that some cards stayed on the stored thumbnail.
    //
    // The check is "did the call end past its budget" rather than "was an entry refused for time",
    // which conflates the two bounds when both are hit in the same call. That is deliberate: they
    // mean the same thing to whoever reads the log (this call gave up early), and distinguishing
    // them would mean threading a flag back out of `resolve_one` for a log line.
    if call_budget_spent(started_at, std::time::Instant::now(), RESOLVE_CALL_BUDGET) {
        logger::warn(
            "thumbnail_display",
            format!(
                "a display thumbnail request used its whole {}s budget. The remaining entries were \
                 left for a later call and are being served from the stored thumbnails",
                RESOLVE_CALL_BUDGET.as_secs()
            ),
        );
    }

    // Restore the positional contract the caller indexes by. The tail the ceiling excluded is
    // BudgetSpent, not Unavailable: nothing was decided about those paths, and a later call carrying
    // fewer of them can still answer properly.
    resolved.resize(relative_paths.len(), DisplayThumbnail::BudgetSpent);

    Ok(resolved)
}

#[cfg(test)]
mod tests;
