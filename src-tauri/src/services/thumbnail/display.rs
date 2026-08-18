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

use tauri::AppHandle;
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
pub fn resolve_display_thumbnails_sync(
    app: &AppHandle,
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
mod tests {
    use super::*;
    use std::time::Duration;

    /// The start instant of a call that has only just begun, so the wall-clock budget is nowhere
    /// near spent and these tests exercise the decision they are actually about.
    fn fresh_call() -> std::time::Instant {
        std::time::Instant::now()
    }

    /// A cache entry at a given age and size, for the eviction tests. Ages are expressed as an
    /// offset from a fixed base rather than from `now`, so the ordering under test is exact.
    fn derivative(name: &str, size_bytes: u64, age: Duration) -> CachedDerivative {
        CachedDerivative {
            path: PathBuf::from(name),
            size_bytes,
            modified_at: SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000) - age,
        }
    }

    #[test]
    fn the_resolve_slot_admits_one_caller_and_frees_on_drop() {
        // The whole contract, in the order that matters. This is the only test that touches the
        // process-global slot, deliberately: a second one running in parallel would race it and the
        // failure would look like flakiness rather than like the shared static it is.
        let held = try_reserve_resolve_slot().expect("the first caller must get the slot");

        assert!(
            try_reserve_resolve_slot().is_none(),
            "a second caller must be refused rather than queued: a page whose rows the user has \
             already scrolled past would otherwise occupy the blocking pool ahead of the one they \
             are looking at"
        );

        drop(held);

        assert!(
            try_reserve_resolve_slot().is_some(),
            "the slot must come back, or the first hung FFmpeg would disable the cache for the \
             rest of the session"
        );
    }

    #[test]
    fn a_refused_call_answers_every_path_as_retryable() {
        // Retryable and not final: nothing was learned about these paths, so recording them as
        // settled would strand cards a later call could resolve. The length has to match too. The
        // caller reads the answer by position against the paths it sent.
        let answers = all_retryable(3);

        assert_eq!(answers.len(), 3);
        assert!(answers
            .iter()
            .all(|answer| *answer == DisplayThumbnail::BudgetSpent));

        assert!(all_retryable(0).is_empty());
    }

    #[test]
    fn a_refused_call_is_bounded_by_the_same_ceiling_as_a_resolved_one() {
        // This exit used to allocate straight from the caller's own count, which is the one thing
        // MAX_RESOLVED_PER_CALL exists to stop the module doing, and it sat in the file whose
        // comments state that rule for every other bound. Answering short costs nothing: the caller
        // reads by position and treats a missing answer exactly as BudgetSpent, i.e. as "ask again".
        assert_eq!(
            all_retryable(MAX_RESOLVED_PER_CALL * 10).len(),
            MAX_RESOLVED_PER_CALL
        );

        // The boundary itself, from both sides, so the ceiling cannot drift into an off-by-one that
        // silently drops one entry of a request that legitimately fills it.
        assert_eq!(
            all_retryable(MAX_RESOLVED_PER_CALL).len(),
            MAX_RESOLVED_PER_CALL
        );
        assert_eq!(
            all_retryable(MAX_RESOLVED_PER_CALL - 1).len(),
            MAX_RESOLVED_PER_CALL - 1
        );
    }

    #[test]
    fn both_ceilings_are_the_same_number() {
        // The two exits that apply the ceiling read it through one function, so a change to
        // MAX_RESOLVED_PER_CALL cannot move one and leave the other behind. Asserted over a request
        // that exceeds it, which is the only size where the two could disagree.
        let oversized: Vec<String> = vec![String::new(); MAX_RESOLVED_PER_CALL + 7];

        assert_eq!(
            within_call_ceiling(&oversized).len(),
            all_retryable(oversized.len()).len()
        );
    }

    #[test]
    fn a_cache_within_its_budget_is_never_touched() {
        // The property the previous age sweep did not have, and the whole reason this replaced it: a
        // cache that fits keeps every entry no matter how old, so a thumbnail the grid has drawn for
        // a year is not discarded and re-encoded for having been written a week ago.
        let entries = vec![
            derivative("a.jpg", 40, Duration::from_secs(60 * 60 * 24 * 365)),
            derivative("b.jpg", 40, Duration::from_secs(0)),
        ];

        assert!(plan_display_cache_eviction(entries, 100).is_empty());
    }

    #[test]
    fn a_cache_exactly_at_its_budget_is_still_within_it() {
        // The boundary: `<=`, not `<`. Getting this wrong evicts on every sweep of a cache that
        // fits perfectly, which is the failure mode of the rule being replaced.
        let entries = vec![derivative("a.jpg", 100, Duration::from_secs(0))];

        assert!(plan_display_cache_eviction(entries, 100).is_empty());
    }

    #[test]
    fn eviction_drops_the_oldest_entries_until_the_cache_fits() {
        // 250 bytes against a 100-byte budget: 150 have to go, which the two oldest cover exactly.
        // The newest must survive. It is the one the grid is most likely to ask for next.
        let entries = vec![
            derivative("newest.jpg", 100, Duration::from_secs(10)),
            derivative("oldest.jpg", 100, Duration::from_secs(300)),
            derivative("middle.jpg", 50, Duration::from_secs(100)),
        ];

        let evicted = plan_display_cache_eviction(entries, 100);

        assert_eq!(
            evicted,
            vec![PathBuf::from("oldest.jpg"), PathBuf::from("middle.jpg")],
            "the oldest entries go first, and only as many as the budget requires"
        );
    }

    #[test]
    fn eviction_stops_as_soon_as_the_cache_fits() {
        // One large old entry is enough to get back under budget, so the two newer ones stay even
        // though the loop has more entries to walk. A plan that kept going would empty the cache to
        // reclaim space it had already reclaimed.
        let entries = vec![
            derivative("huge-old.jpg", 500, Duration::from_secs(900)),
            derivative("small-new.jpg", 10, Duration::from_secs(1)),
            derivative("small-newer.jpg", 10, Duration::from_secs(0)),
        ];

        let evicted = plan_display_cache_eviction(entries, 100);

        assert_eq!(evicted, vec![PathBuf::from("huge-old.jpg")]);
    }

    #[test]
    fn eviction_of_an_empty_cache_plans_nothing() {
        assert!(plan_display_cache_eviction(Vec::new(), DISPLAY_CACHE_MAX_BYTES).is_empty());
        // A zero budget with nothing in it still has nothing to drop, which is the branch a
        // subtraction underflow would panic on.
        assert!(plan_display_cache_eviction(Vec::new(), 0).is_empty());
    }

    #[test]
    fn a_zero_budget_evicts_the_whole_cache() {
        let entries = vec![
            derivative("a.jpg", 1, Duration::from_secs(200)),
            derivative("b.jpg", 1, Duration::from_secs(100)),
        ];

        assert_eq!(plan_display_cache_eviction(entries, 0).len(), 2);
    }

    /// The grid's page size, read from the fixture both sides assert against.
    fn shared_media_page_size() -> usize {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../shared/media-page-size.json"
        ));
        let fixture: serde_json::Value =
            serde_json::from_str(raw).expect("the shared fixture must be valid JSON");

        fixture["mediaPageSize"]
            .as_u64()
            .expect("mediaPageSize must be a number") as usize
    }

    #[test]
    fn the_generation_budget_covers_a_full_page_of_the_grid() {
        // The two constants live on opposite sides of the IPC boundary and nothing else forces them
        // to move together, which is how they came to disagree: a budget of 64 against a page of 100
        // left 36 cards of a first-visited channel without a derivative, and (because the caller
        // re-asks only when its item list changes), a channel that fits in one page never got them.
        // A budget *above* the page size is fine (it only bounds a caller asking for more than a
        // page). Below it silently degrades the feature, so this is the direction that is asserted.
        let page_size = shared_media_page_size();

        assert!(
            MAX_GENERATIONS_PER_CALL >= page_size,
            "the generation budget ({MAX_GENERATIONS_PER_CALL}) must cover a full page of the grid \
             ({page_size}), or the tail of a first-visited page never gets a derivative"
        );

        // The cheap half's ceiling has to clear a page too, or a legitimate first visit would be
        // truncated, and truncation logs a warning that says no legitimate flow reaches it.
        assert!(
            MAX_RESOLVED_PER_CALL >= page_size,
            "the per-call ceiling ({MAX_RESOLVED_PER_CALL}) must not truncate a single page \
             ({page_size})"
        );
    }

    #[test]
    fn the_display_cache_budget_is_two_hundred_mebibytes() {
        // Spelled as the resolved byte count rather than as the same product the constant is
        // written with, so an arithmetic slip in that expression moves one side and not the other.
        // Nothing else pinned the magnitude at all: every eviction test below passes its own
        // `max_bytes`, so the constant was free to be any number, and a weekly mutation run duly
        // reported `*` swapped for `+` and for `/` as surviving. What that would cost is not
        // theoretical. The startup sweep trims the cache to this value, so a slip downward
        // discards derivatives the grid is about to redraw, and one upward lets a disposable
        // directory grow without a bound worth the name.
        assert_eq!(display_cache_max_bytes(), 209_715_200);
    }

    #[test]
    fn a_request_is_truncated_only_when_the_ceiling_dropped_something() {
        // Both replacements the mutation run found, on the exact boundary. `>` silences the warning
        // on a genuinely truncated call (the one case it exists to announce), and `<=` fires it on
        // every exact-fit page, which is the reading that sends whoever opens the log looking for a
        // caller asking beyond a page when none did.
        assert!(request_was_truncated(
            MAX_RESOLVED_PER_CALL,
            MAX_RESOLVED_PER_CALL + 1
        ));
        assert!(!request_was_truncated(
            MAX_RESOLVED_PER_CALL,
            MAX_RESOLVED_PER_CALL
        ));
        assert!(!request_was_truncated(0, 0));

        // A normal page, which is what every real call is: nothing dropped, so nothing said.
        assert!(!request_was_truncated(64, 64));
    }

    #[test]
    fn within_call_ceiling_passes_a_normal_page_through_untouched() {
        // A page of the grid is a few dozen rows, so the ceiling must never be what a real call
        // meets. Otherwise it would be silently degrading the feature it is protecting.
        let page: Vec<String> = (0..64)
            .map(|index| format!("thumbnails/{index}.jpg"))
            .collect();

        assert_eq!(within_call_ceiling(&page).len(), 64);
    }

    #[test]
    fn within_call_ceiling_truncates_an_oversized_request_at_the_boundary() {
        // Both sides of the comparison, on the exact boundary: a request of exactly the ceiling is
        // fully served, and one entry more is truncated to the ceiling rather than to zero or to
        // one-off either way.
        let exact: Vec<String> = vec![String::new(); MAX_RESOLVED_PER_CALL];
        assert_eq!(within_call_ceiling(&exact).len(), MAX_RESOLVED_PER_CALL);

        let over: Vec<String> = vec![String::new(); MAX_RESOLVED_PER_CALL + 1];
        assert_eq!(within_call_ceiling(&over).len(), MAX_RESOLVED_PER_CALL);

        let far_over: Vec<String> = vec![String::new(); MAX_RESOLVED_PER_CALL * 10];
        assert_eq!(within_call_ceiling(&far_over).len(), MAX_RESOLVED_PER_CALL);
    }

    #[test]
    fn within_call_ceiling_keeps_the_leading_entries_in_order() {
        // The caller reads the answer by position, so the prefix has to be the *leading* entries and
        // has to stay in order. A truncation that took the tail would answer every entry with the
        // wrong derivative.
        let requested: Vec<String> = (0..3)
            .map(|index| format!("thumbnails/{index}.jpg"))
            .collect();

        assert_eq!(within_call_ceiling(&requested), requested.as_slice());
    }

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
        // derivative and the caller renders the canonical file, which is what it did before this
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
    fn display_thumbnail_file_name_carries_the_format_and_the_width() {
        // ffmpeg picks its encoder from the output extension, so the name is what decides the bytes.
        let name = display_thumbnail_file_name("abc");

        assert_eq!(
            name,
            format!("abc-w{DISPLAY_THUMBNAIL_MAX_WIDTH}.{THUMBNAIL_OUTPUT_FORMAT}")
        );

        // The width has to be in the name, because nothing revalidates a cached file's dimensions:
        // is_usable_file asks only whether it exists and is non-empty, so a name that omitted the
        // width would keep serving the old size after DISPLAY_THUMBNAIL_MAX_WIDTH changed. Asserting
        // it as a substring (and not merely that the two names differ) is what pins the change as
        // self-invalidating.
        assert!(
            name.contains(&format!("w{DISPLAY_THUMBNAIL_MAX_WIDTH}")),
            "the width must be part of the name so a change to it invalidates the cache: {name}"
        );
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
        // so this is already true by construction. Asserting it is what stops a future rewrite from
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
    fn the_call_budget_is_spent_exactly_at_its_boundary() {
        // Both sides of the `>=`, on the exact boundary. A `>` here would let a call that has
        // already spent its budget start one more FFmpeg child, which at the per-process timeout is
        // another twenty seconds on a blocking-pool thread.
        let started = std::time::Instant::now();
        let budget = Duration::from_secs(120);

        assert!(!call_budget_spent(started, started, budget));
        assert!(!call_budget_spent(
            started,
            started + budget - Duration::from_millis(1),
            budget
        ));
        assert!(call_budget_spent(started, started + budget, budget));
        assert!(call_budget_spent(
            started,
            started + budget + Duration::from_secs(60),
            budget
        ));
    }

    #[test]
    fn a_clock_that_did_not_advance_never_reports_the_budget_as_spent() {
        // `now` before `started_at` should not be reachable with a monotonic Instant, but this
        // function guards a process spawn and receives both values from its caller, so the
        // saturating subtraction is what keeps a wrong argument from panicking there.
        let started = std::time::Instant::now();
        let budget = Duration::from_secs(120);

        assert!(!call_budget_spent(
            started + Duration::from_secs(5),
            started,
            budget
        ));
    }

    #[test]
    fn the_call_budget_leaves_room_for_more_than_one_generation() {
        // The invariant that keeps the bound from silently disabling the feature: if the call budget
        // were at or below the per-process timeout, a single hung FFmpeg would consume the whole
        // call, every call, and no derivative would ever be produced again on that machine, with
        // nothing to show for it but a warning per page.
        assert!(
            RESOLVE_CALL_BUDGET > DISPLAY_THUMBNAIL_TIMEOUT,
            "the call budget ({RESOLVE_CALL_BUDGET:?}) must exceed one generation's timeout \
             ({DISPLAY_THUMBNAIL_TIMEOUT:?})"
        );
    }

    #[test]
    fn a_call_that_is_out_of_time_reports_retryable_and_keeps_its_slots() {
        // The bound this exists for, at the level it acts on. Retryable rather than final: the path
        // is fine and the source is there, so a later call must still be free to resolve it, and
        // the slot must not be spent discovering that the call is over time, or a page arriving late
        // would burn its whole budget refusing entries.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-display-out-of-time-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(dir.join(LIBRARY_DIR_THUMBNAILS)).unwrap();

        let hash = "b".repeat(64);
        let relative = format!("thumbnails/thumb_{hash}.jpg");
        std::fs::write(dir.join(&relative), b"\xff\xd8\xff").unwrap();

        // A call that started a full budget ago is already over time by the time it reaches here.
        let started_at = std::time::Instant::now() - RESOLVE_CALL_BUDGET;
        let mut generations_left = 5usize;

        let resolved = resolve_one(
            &dir.to_string_lossy(),
            &relative,
            &dir,
            Some("ffmpeg"),
            &mut generations_left,
            started_at,
        );

        assert_eq!(resolved, DisplayThumbnail::BudgetSpent);
        assert_eq!(
            generations_left, 5,
            "a call that is out of time must not spend a slot to find that out"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_out_of_time_call_still_serves_what_is_already_cached() {
        // The deliberate asymmetry: the budget bounds generations, not answers. A cache hit is one
        // stat, so refusing it once the call is over time would make a warmed page fall back to the
        // full-size stored file for no reason. The same reasoning MAX_GENERATIONS_PER_CALL states,
        // applied to the clock.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-display-hit-out-of-time-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let hash = "c".repeat(64);
        let cached = dir.join(display_thumbnail_file_name(&hash));
        std::fs::write(&cached, b"\xff\xd8\xff").unwrap();

        let started_at = std::time::Instant::now() - RESOLVE_CALL_BUDGET;
        let mut generations_left = 0usize;

        let resolved = resolve_one(
            "/no/such/library",
            &format!("thumbnails/thumb_{hash}.jpg"),
            &dir,
            None,
            &mut generations_left,
            started_at,
        );

        assert_eq!(resolved, DisplayThumbnail::resolved(cached));

        let _ = std::fs::remove_dir_all(&dir);
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
            fresh_call(),
        );

        // Unavailable, not BudgetSpent: the name came off the row and will not change, so telling
        // the caller to ask again would have it re-ask about this path on every page for the rest
        // of the session.
        assert_eq!(resolved, DisplayThumbnail::Unavailable);
        assert_eq!(generations_left, 1, "a refused name must not spend budget");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_exhausted_budget_is_reported_as_retryable_rather_than_final() {
        // The distinction this enum exists for, and the one case that is genuinely worth asking
        // about again: the path is fine, the source is there, and the only reason there is no
        // derivative is that this call had no slots left.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-display-budget-spent-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let hash = "e".repeat(64);
        let relative = format!("thumbnails/thumb_{hash}.jpg");
        // The source has to exist *at the path the relative one resolves to*, or the miss is
        // classified before the budget is ever consulted and this asserts nothing.
        std::fs::create_dir_all(dir.join(LIBRARY_DIR_THUMBNAILS)).unwrap();
        std::fs::write(dir.join(&relative), b"\xff\xd8\xff").unwrap();

        let mut generations_left = 0usize;
        let resolved = resolve_one(
            &dir.to_string_lossy(),
            &relative,
            &dir,
            Some("ffmpeg"),
            &mut generations_left,
            fresh_call(),
        );

        assert_eq!(resolved, DisplayThumbnail::BudgetSpent);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_ffmpeg_is_final_and_never_spends_the_budget() {
        // Both halves matter. Final, because no entry in any later call can produce a derivative
        // without FFmpeg either, and marking it retryable is precisely what made a machine without
        // FFmpeg re-ask about its whole library on every page. And free, because the check now runs
        // before the slot is taken: paying a slot per entry to rediscover the same missing binary
        // would exhaust the budget on nothing.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-display-no-ffmpeg-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let hash = "f".repeat(64);
        let relative = format!("thumbnails/thumb_{hash}.jpg");
        // Same trap as the budget test above: without a source at the resolved path this would
        // return Unavailable for the wrong reason and pass while asserting nothing about FFmpeg.
        std::fs::create_dir_all(dir.join(LIBRARY_DIR_THUMBNAILS)).unwrap();
        std::fs::write(dir.join(&relative), b"\xff\xd8\xff").unwrap();

        let mut generations_left = 3usize;
        let resolved = resolve_one(
            &dir.to_string_lossy(),
            &relative,
            &dir,
            None,
            &mut generations_left,
            fresh_call(),
        );

        assert_eq!(resolved, DisplayThumbnail::Unavailable);
        assert_eq!(
            generations_left, 3,
            "a machine without FFmpeg must not spend the budget discovering that"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_outside_the_thumbnails_directory_is_final() {
        // A containment refusal is a property of the stored value, so it can never become
        // resolvable. It also must not be reachable at all through this command, which is why the
        // check stays even though the answer is the same as an unwritable name.
        let dir = std::env::temp_dir().join(format!(
            "kavynex-display-scope-{}",
            crate::utils::naming::unique_temp_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let hash = "a".repeat(64);
        let mut generations_left = 2usize;

        let resolved = resolve_one(
            &dir.to_string_lossy(),
            &format!("video/thumb_{hash}.jpg"),
            &dir,
            Some("ffmpeg"),
            &mut generations_left,
            fresh_call(),
        );

        assert_eq!(resolved, DisplayThumbnail::Unavailable);
        assert_eq!(generations_left, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_budget_spent_invites_another_request() {
        // The property the caller depends on, asserted over the whole enum rather than per case: it
        // records everything that is not BudgetSpent and stops asking about it. A new variant that
        // is really "try later" has to be added to this list deliberately.
        let retryable = [
            DisplayThumbnail::BudgetSpent,
            DisplayThumbnail::Unavailable,
            DisplayThumbnail::resolved(PathBuf::from("/cache/a.jpg")),
        ]
        .into_iter()
        .filter(|answer| matches!(answer, DisplayThumbnail::BudgetSpent))
        .count();

        assert_eq!(retryable, 1);
    }

    #[test]
    fn a_cached_derivative_is_returned_without_touching_the_library() {
        // The hit path must not need the library at all: no containment check, no source stat, no
        // FFmpeg. Passing a library path that does not exist and an ffmpeg that could never run is
        // what proves it, if either were consulted, this would return None.
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
            fresh_call(),
        );

        assert_eq!(resolved, DisplayThumbnail::resolved(cached));

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
            fresh_call(),
        );

        // Final rather than retryable, which is a judgment worth stating: the file could come back
        // (a drive remounted), but re-asking on every page will not be what brings it back, and a
        // fresh launch retries it anyway. Being wrong here costs one session of drawing the stored
        // thumbnail. Being wrong the other way costs the unbounded re-asking this change removes.
        assert_eq!(resolved, DisplayThumbnail::Unavailable);
        assert_eq!(
            generations_left, 4,
            "a source that is not there must not spend budget either"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
