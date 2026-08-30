// The tests for the parent module, kept in a file of their own so the module reads as its
// production code. Same module as before (`mod tests` declared under `#[cfg(test)]` in the
// parent), so `use super::*` still reaches every private item it did.

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
    // process-global slot, deliberately. A second one running in parallel would race it and the
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
    // Retryable and not final. Nothing was learned about these paths, so recording them as
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
    // comments state that rule for every other bound. Answering short costs nothing. The caller
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
    // The property the previous age sweep did not have, and the whole reason this replaced it. A
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
    // The boundary. `<=`, not `<`. Getting this wrong evicts on every sweep of a cache that
    // fits perfectly, which is the failure mode of the rule being replaced.
    let entries = vec![derivative("a.jpg", 100, Duration::from_secs(0))];

    assert!(plan_display_cache_eviction(entries, 100).is_empty());
}

#[test]
fn eviction_drops_the_oldest_entries_until_the_cache_fits() {
    // 250 bytes against a 100-byte budget. 150 have to go, which the two oldest cover exactly.
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
    // to move together, which is how they came to disagree. A budget of 64 against a page of 100
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
    // Nothing else pinned the magnitude at all. Every eviction test below passes its own
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

    // A normal page, which is what every real call is. Nothing dropped, so nothing said.
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
    // Both sides of the comparison, on the exact boundary. A request of exactly the ceiling is
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
    // The whole reason a hit is cheap. The hash is already in the name the app wrote, so the key
    // costs a string split rather than a read of the very file the derivative exists to avoid
    // decoding.
    let hash = "a".repeat(64);

    assert_eq!(
        display_cache_key(&format!("thumbnails/thumb_{hash}.jpg")),
        Some(hash.clone())
    );

    // The extension is not part of the key. The derivative is always THUMBNAIL_OUTPUT_FORMAT,
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

    // The width has to be in the name, because nothing revalidates a cached file's dimensions.
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

    // `min(max,iw)` and not a bare width. The two producers write at different sizes (a yt-dlp
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
    // Both directions of the accounting, which the caller cannot exercise. Reaching the spend
    // needs a real FFmpeg run, so a budget that counted upward, divided instead of decremented,
    // or never hit its floor would be invisible from `resolve_one`.
    let mut generations_left = 2usize;

    assert_eq!(take_generation_slot(&mut generations_left), Some(()));
    assert_eq!(generations_left, 1, "a slot must cost exactly one");

    assert_eq!(take_generation_slot(&mut generations_left), Some(()));
    assert_eq!(generations_left, 0);

    // Exhausted. Refuses without wrapping the counter, which on a usize would panic in debug
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
    // The invariant that keeps the bound from silently disabling the feature. If the call budget
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
    // The bound this exists for, at the level it acts on. Retryable rather than final. The path
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
#[cfg(unix)]
fn a_symlinked_source_is_unavailable_and_never_reaches_ffmpeg() {
    use std::os::unix::fs::symlink;

    // Told apart from "no FFmpeg" by the budget. A regular file with the same inputs reaches the
    // slot check and answers BudgetSpent when no slot is left, so Unavailable here means the
    // refusal happened before the FFmpeg step, not that the step failed.
    let dir = std::env::temp_dir().join(format!(
        "kavynex-display-symlink-{}",
        crate::utils::naming::unique_temp_suffix()
    ));
    let outside = dir.join("outside");
    std::fs::create_dir_all(dir.join(LIBRARY_DIR_THUMBNAILS)).unwrap();
    std::fs::create_dir_all(&outside).unwrap();

    let target = outside.join("real.jpg");
    std::fs::write(&target, b"\xff\xd8\xff").unwrap();

    let hash = "c".repeat(64);
    let linked = format!("thumbnails/thumb_{hash}.jpg");
    symlink(&target, dir.join(&linked)).unwrap();

    let regular = format!("thumbnails/thumb_{}.jpg", "d".repeat(64));
    std::fs::write(dir.join(&regular), b"\xff\xd8\xff").unwrap();

    let started_at = std::time::Instant::now();
    let mut no_slots = 0usize;

    assert_eq!(
        resolve_one(
            &dir.to_string_lossy(),
            &regular,
            &dir,
            Some("ffmpeg"),
            &mut no_slots,
            started_at
        ),
        DisplayThumbnail::BudgetSpent,
        "the control: a regular file with no slot left reaches the budget check"
    );
    assert_eq!(
        resolve_one(
            &dir.to_string_lossy(),
            &linked,
            &dir,
            Some("ffmpeg"),
            &mut no_slots,
            started_at
        ),
        DisplayThumbnail::Unavailable,
        "a symlink is refused before the budget, so it cannot be what FFmpeg reads"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_out_of_time_call_still_serves_what_is_already_cached() {
    // The deliberate asymmetry. The budget bounds generations, not answers. A cache hit is one
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
    // The case this exists for. A generation killed after creating its output leaves an empty
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

    // Unavailable, not BudgetSpent. The name came off the row and will not change, so telling
    // the caller to ask again would have it re-ask about this path on every page for the rest
    // of the session.
    assert_eq!(resolved, DisplayThumbnail::Unavailable);
    assert_eq!(generations_left, 1, "a refused name must not spend budget");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_exhausted_budget_is_reported_as_retryable_rather_than_final() {
    // The distinction this enum exists for, and the one case that is genuinely worth asking
    // about again. The path is fine, the source is there, and the only reason there is no
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
    // before the slot is taken. Paying a slot per entry to rediscover the same missing binary
    // would exhaust the budget on nothing.
    let dir = std::env::temp_dir().join(format!(
        "kavynex-display-no-ffmpeg-{}",
        crate::utils::naming::unique_temp_suffix()
    ));
    std::fs::create_dir_all(&dir).unwrap();

    let hash = "f".repeat(64);
    let relative = format!("thumbnails/thumb_{hash}.jpg");
    // Same trap as the budget test above. Without a source at the resolved path this would
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
    // The property the caller depends on, asserted over the whole enum rather than per case. It
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
    // The hit path must not need the library at all. No containment check, no source stat, no
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

    // Final rather than retryable, which is a judgment worth stating. The file could come back
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
