# Mutation testing (Rust)

`cargo-mutants` rewrites the logic of the modules in scope (an inverted `starts_with`, a dropped
`!`, an off-by-one, a swapped return) and fails when the suite still passes. That answers a question
line coverage cannot: whether the tests over this code actually kill a logic mutant, or merely
execute the line. Coverage on these files was already high before any of them was gated.

The configuration is `src-tauri/.cargo/mutants.toml`. It holds the scope, the exclusions and a one
line reason for each. This document holds the rest: the procedure for widening the scope, the
measured pass behind every entry, and the reasoning behind every exclusion. The two are meant to be
read together, with the config answering "what is gated" and this answering "why".

The frontend counterpart is Stryker (`stryker.config.json`), which mutates `src/` only.

## Running it

```bash
cargo mutants --manifest-path src-tauri/Cargo.toml
```

`--in-place` is required to run it against this repository at all: the copy mode leaves the
repo-root `../shared` parity fixture behind (see `.github/workflows/mutation.yml`).

CI runs it on a weekly schedule (`.github/workflows/mutation.yml`). A surviving mutant makes
cargo-mutants exit 2, which fails that run.

Measuring one file on its own, which is what every entry below was added after:

```bash
cargo mutants --manifest-path src-tauri/Cargo.toml --in-place --no-config --file <path>
```

`--no-config` turns `exclude_re` off, so a measurement reports the excluded mutants too. Several
notes below say "three missed, all already excluded", which is that flag rather than a regression.

## Widening the scope

The scope is not "every file". It is the modules whose regression cost is highest, kept inside the
CI time budget. A file joins it the same way every current entry did:

1. Measure it on its own with the command above.
2. Triage every survivor. A survivor is one of four things: a real gap, an equivalent mutant, a
   boundary a unit test cannot pin, or a body compiled only on another platform.
3. **Kill the real gaps with tests before adding the glob**, so the entry goes in green rather than
   red.
4. Add the glob, and add this file a row recording the pass.

Step 3 is the one that carries the value. Most entries below found at least one real gap, and two
found defects that were live in shipped code.

### Two lessons this exercise keeps producing

**An unkillable mutant is often a type that collapsed two decisions into one value.**
`thumbnail::display::take_generation_slot` returned `None` both when the budget was exhausted and
when FFmpeg had failed, so `delete !` on its caller was genuinely unkillable: both branches led to
the same value. `resolve_one` returns `DisplayThumbnail` now, so an exhausted budget answers
`BudgetSpent` and every other miss answers `Unavailable`, and the mutant dies to an ordinary test.
Look for this before writing an exclusion.

**"There is no portable way to trigger this branch" is a statement about the caller, not about the
decision.** `live_chat_storage.rs` was expected to need two exclusions for its failure counters.
Moving one decision into `record_unreadable_entry` put it one call from a test, and the other turned
out to be reachable after all (a *directory* at the `.gztmp` staging path makes the staged write
fail on every platform, with no permissions involved). It went in with no exclusions at all.

### Exclusions go stale silently, which is why they are gated

Two entries in this file died without anything noticing, both after a pure extraction renamed the
mutant they matched: `replace < with <= in is_recent` (the comparison became `duration_is_recent`)
and `in ensure_schema` (the guard became `needs_migration`). The second is the instructive one. The
mutant it named was live for days, and the next scheduled run would have reported it as a survivor
with nothing to suggest the entry rather than the tests had gone stale.

`scripts/verify-mutants-exclusions.js` now fails CI when an `exclude_re` entry matches no mutant
cargo-mutants would generate. It answers "does this pattern still name something", never "is this
exclusion still justified"; the second needs the triage recorded here.

## Scope

Every glob in `examine_globs`, with the pass that admitted it. Counts are from the measurement
command above.

| Module | Added | Measured | Outcome |
|---|---|---|---|
| `utils/path.rs`, `library/guard.rs`, `yt_dlp/url.rs`, `binaries.rs` | initial | | The four the gate started with: path containment, the library-path guard, the yt-dlp host allow-list, external-binary resolution. |
| `services/filesystem.rs` | 2026-07-17, re-measured 07-18 | 131 mutants, 43 missed | The matching helpers held most of the killable ones. An existing preference test picked the preferred file only because it was also the newest, so a flipped preference comparison survived; the rest were prefix-named-subdirectory and non-directory cases no test exercised. Covered by tests now. |
| `services/library/media.rs`, `services/library/cleanup.rs` | 2026-07-18 | 111 mutants, 94 unviable, 14 caught, 3 missed | All three were in `execute_plan`'s early-return branches, whose field population no test asserted because that function needs a live `AppHandle`. Extracted into `report_for_nothing_deletable` / `report_for_unavailable_library` and covered. |
| `services/db_backup/mod.rs` | 2026-07-19 | 137 mutants, 14 missed | Off-by-one and boundary checks the tests skirted: the restore/import schema-version gates, the backup-status timestamp, the throttle constant, and the apply-pending recovery guard (an `AND` weakened to `OR` would revert a leftover undo snapshot on every launch). |
| `commands/live_chat.rs` | 2026-07-20 | 32 mutants, 31 unviable, 1 caught | The one command module that re-implements the containment pattern rather than delegating to `library::guard`. Its one viable mutant is the unlink-rewording gate, extracted into `reword_unlink_error_after_reference_clear`. |
| `services/ssrf_guard.rs` | 2026-07-21 | 73 mutants, 3 unviable, 70 caught, 0 missed | The tunnel decoders were split into pure functions pinned by an exact-value test. That is what kills the shift/mask/XOR mutants a classification-only test let survive, since many wrong octets still land in the same allow/deny band. |
| `services/db_backup/*.rs` (widened from `mod.rs`) | 2026-07-24 | 108 mutants, 42 unviable, 49 caught, 17 missed | Five missed were the WAL-busy branch excluded below; the rest were killed by new tests. Kept as a directory glob deliberately, which paid off on 2026-07-31 when `snapshot.rs` and `restore.rs` were split out of `mod.rs` and were in scope from the moment they existed. |
| `services/yt_dlp/download/command.rs` | 2026-07-24 | 12 mutants, 5 unviable, 7 caught, 0 missed | The argv builder, the `--` separator and the request validation. Scoped to `command.rs` rather than the directory: `mod.rs` is async process orchestration no unit test can drive. |
| `services/db_schema/*.rs` | 2026-07-25 | 106 mutants, 84 unviable, 15 caught, 7 missed | Six were the `> 0` log guards excluded below; the seventh was the `RebuildConnection` `Drop` impl, now killed by a pair of tests asserting both directions of the detach-vs-return decision. |
| `services/yt_dlp/download/redaction.rs` | 2026-07-26 | 34 mutants, 6 unviable, 28 caught, 0 missed | The argv redaction keeping the cookies path, the ffmpeg directory, the temp directory and the pasted URL out of a line users paste into public bug reports. `is_valid_run_id` / `is_valid_format_id` moved into `command.rs` in the same change: they were defined in the ungated `mod.rs`, so no mutant was ever generated for the character-class filter in front of `-f`. |
| `services/pending_media.rs`, `services/library/recovery.rs` | 2026-07-27, re-measured 07-29 and 07-31 | 95 mutants, 36 caught, 11 missed (pending_media); 15 mutants, 14 caught, 0 missed (recovery) | Two real gaps, both covered now. Weakening the `\|\|` in the entry filter let an unrelated filename be parsed as a marker, and what that function returns goes straight to a cleanup that unlinks files. And `record_marker_attempt`'s write-back had nothing observing it, so a broken write-back looked identical to a working one until the retry never ended. |
| `services/yt_dlp/cookies.rs` | 2026-07-27 | 11 mutants, 11 caught, 0 missed | The `.txt` gate, the network-path refusal, and the browser allow-list deciding which cookie store yt-dlp may read. Clean. |
| `commands/security.rs` | 2026-07-27 | 32 mutants, 23 unviable, 8 caught, 1 missed | The survivor was real: `canonical != primary` in `grant_path_with_canonical` had no test, and inverting it skips the canonical grant in exactly the case the function exists for (the `\\?\` form on Windows), which fails as every thumbnail and video silently not loading. |
| `commands/database.rs` | 2026-07-27 | 22 mutants, 16 unviable, 6 caught, 0 missed | Both directions of the gate on a destructive overwrite. Measured with `--examine-re` scoped to `prepare_export_destination` / `prepare_import_source` / `destination_is_inside_dir`; a partial full-file pass confirmed the same six viable mutants. The glob is the whole file regardless. |
| `utils/validation.rs` | 2026-07-27 | 31 mutants, 16 unviable, 15 caught, 0 missed | The validators every write boundary calls. Clean. |
| `services/thumbnail/url.rs` | 2026-07-27 | 4 mutants, 4 caught, 0 missed, in 85s | The host allow-list on the direct thumbnail fetch. Extracted rather than gating the whole download module, whose remainder is async orchestration. The runtime is the extraction's whole payoff. |
| `services/thumbnail/display.rs` | 2026-07-29, re-measured 07-30 and 08-02 | 42 mutants, 14 unviable, 24 caught, 4 missed | All four inside the excluded FFmpeg spawn. `display_cache_key` decides which stored file a cached derivative answers for, so a weakened check renders one media's thumbnail on another's card, which nothing crashes on. Two rounds were needed; see the type-collapse lesson above. |
| `services/media_creation.rs` | 2026-07-30 | 105 mutants, 66 unviable, 22 caught, 17 missed | Three real gaps, each needing an extraction because the deciding line sat inside an `AppHandle`-bound async function: `fetched_thumbnail_to_discard`, `nothing_to_clean_up`, `needs_youtube_duplicate_pre_check`. A fourth was a plain test gap (`media_type` left untrimmed by `normalize_create_media_request`). Re-measured over the four: 28 mutants, 24 caught, 0 missed. |
| `services/thumbnail/picked.rs` | 2026-07-30 | 8 mutants, 4 caught, 4 unviable, 0 missed | The gate on an image picked from the file dialog. It is here because the gate it replaced was here: the manual preview used to widen the asset scope through `allow_asset_file`. Its own module rather than a widened glob over `thumbnail/temp.rs`, where the same pass reported 86 mutants with 15 missed, all in FFmpeg spawn and deadline arithmetic. |
| `services/library/migration.rs` | 2026-07-30 | 37 mutants, 2 missed | One was a live defect: `replace && with \|\| in ensure_destination_is_migratable` made *any* subdirectory read as a managed one, so a folder full of the user's own files passed the "destination must be empty" gate and the library was migrated into it. Every existing test placed a managed directory or a loose file there, never an unrelated directory. |
| `services/live_chat_storage.rs` | 2026-07-30, re-measured 07-31 | 137 mutants, 44 caught, 93 unviable, 0 missed | Six real gaps killed first: both decompression-bomb ceilings had only their over-the-limit side covered, so tightening `>` to `>=` was invisible; the 512 MiB constant had nothing pinning its arithmetic; and both guards in `list_live_chat_relative_paths` were unpinned, where inverting either makes a populated library report no replays at all. Goes in with no exclusions. |
| `services/thumbnail/redirect.rs` | 2026-07-31 | 13 mutants, 5 caught, 8 unviable, 0 missed | The per-hop redirect decision, and the strongest reason any of these extractions has had: `fetch.rs` uses a hand-rolled hyper client *because* it follows redirects manually so the SSRF guard re-runs per hop, and that decision was the one part of the module no gate could reach. The image-CDN host gate landed in `next_hop` precisely so it would be one of those five. |
| `services/thumbnail/download/process.rs` | 2026-08-16 | 12 mutants, 12 caught, 0 missed, in 5min (after a first pass of 13 with 2 missed) | The last unreached piece of the thumbnail spawn. `read_drain_capped_async` takes its cap as an argument and reads any `AsyncRead`, so a counting reader pins the cap arithmetic and the drain-past-the-cap property with no child process at all, which is what let this file in without the blanket exclusion `thumbnail/temp.rs` needed. One survivor was a real gap **in the test rather than in the code**, and the shape is worth remembering: the test read 512-byte chunks into a 100-byte cap, so the buffer filled exactly on the first chunk and `max_bytes - buffer.len()` was never evaluated with a non-zero buffer. Replacing that `-` with a `+` therefore changed nothing observable. At 30 into 100 the last chunk straddles the cap and the mutant overshoots to 120 bytes. A boundary test that never reaches the boundary passes for the wrong reason. |
| `services/video_repository/media_page.rs` | 2026-07-31 | 21 mutants, 6 caught, 15 unviable, 0 missed, in 3min | `resolve_order_by` is exactly this gate's shape: a `match` returning a `&'static str`, where a swapped arm is not a crash and not an error but the wrong rows in the wrong order. The first entry needing neither an extraction nor a narrowing. |
| `services/library/verification.rs`, `services/library/integrity.rs` | 2026-08-16 | 90 mutants, 65 caught, 17 unviable, 8 missed (32/22/6/4 and 58/43/11/4), in 12min and 15min | The two functions that answer "is my library intact", measured together because the concern that sent an audit here was that neither had a gate. That concern did not survive the measurement, which is the row's point: **every polarity decision was already killed** by the existing tests. Verified/Corrupt/Unverifiable/Unreadable, missing/orphan/invalid, zero-length as corrupt rather than healthy, the post-hash cancel re-check, and the subtree confinement. What survived was one decision written five times, in both files: nothing held the per-category example cap, so a guard weakened from `<` to `<=` kept one more path than the constant says. Covered now, in both directions, because they fail oppositely: a cap that reached the *count* would under-report the damage to the user, and a cap missing from the *list* would put every path in a library-sized report onto the IPC boundary. `integrity.rs` spelled that cap as a bare `5` at four sites, which is why one decision reported as four survivors; it is a named constant now. The three remaining are the `> 0` log guard excluded below. |

| `services/library/paths.rs` | 2026-08-23 | 49 mutants, 3 missed, 13 caught, 33 unviable; re-measured at 46 mutants, 1 missed (the excluded cfg-split body), 12 caught, 33 unviable, in 12min | The library-folder helpers, and `library_path_is_inside_dir`, the decision behind "the library cannot live inside the app config directory" (the database and every backup generation sit there). That function had no test at all, so a weakened `starts_with` would have let the library be moved in among the backups unnoticed; it is pinned in both directions now, with the fail-open branches. The other real gap was a happy-path test missing for `resolve_existing_directory_sync`, which let `delete !` on its existence check survive. The third survivor was a dead guard: the `!text.starts_with(r"\\?\")` check in `to_extended_length_path` can never be false, because a `\\?\` spelling parses as `VerbatimDisk` and returns earlier, so the guard was removed rather than excluded. What remains excluded is the cfg-split pass-through body, see below. |

| `utils/io.rs`, `utils/format.rs`, `error.rs` | 2026-08-24 | 82 mutants, 66 caught, 10 unviable, 2 missed, 4 timeouts, in 49min (`format.rs` 42/42 and `error.rs` 8 caught + 6 unviable, both clean; every survivor and every timeout is in `io.rs`) | Admitted by the whole-crate measurement below. `read_lossy_line_capped` bounds each chunk with `max_bytes - buf.len()`, and every test read from a slice, whose `fill_buf` hands back the whole thing at once, so the subtraction was only ever evaluated against an empty buffer, where it agrees with an addition. Both copies of it were unpinned: a cap that grew by the buffer's own length would have gone unnoticed, on the reader that bounds every line of child-process output. Reading through a small-capacity `BufReader` is what makes the second chunk straddle the cap, and the fix was proven by hand before the glob went in (mutate, watch the two new tests go red and the six old ones stay green). The same gap in the same shape as `read_drain_capped_async`, which is the lesson two rows above. Both ceilings are pinned too, one in a `const` block. In `format.rs`, two tests walked `allowed_media_extensions()` with a `for` loop, so an empty list satisfied them without running an assertion, leaving the function the rejection message is built from unpinned; and `normalize_yt_dlp_upload_date`'s guard could not tell `\|\|` from `&&`, because every value the tests rejected failed both halves at once. `error.rs`'s `Display` is what every `logger::` call formats and nothing asserted it. |

### The whole crate was measured once, and that is why the scope is still not "every file"

**2026-08-24.** Everything outside `examine_globs` was measured in one pass (1504 mutants, sharded
across two worktrees, about four hours each): **265 survivors, 389 caught, 844 unviable.** The three
files in the row above came out of it. The rest is recorded here so the question "why not just gate
the whole crate?" has a measured answer instead of an opinion.

| Where the 265 sat | Count | What they are |
|---|---|---|
| `yt_dlp/metadata.rs`, `yt_dlp/download/mod.rs` | 90 | Async orchestration around a spawned process. The decisions were already extracted into `command.rs` and `redaction.rs`, which are in scope and clean. |
| `lib.rs` | 30 | `setup()` and the `spawn_*` tasks, which need a live `AppHandle`, a pool and a window. |
| `temp_cleanup.rs`, `utils/process.rs` | 37 | Cache sweeps and process spawning/killing. |
| `thumbnail/temp.rs`, `thumbnail/download/mod.rs`, `download/fetch.rs` | 35 | FFmpeg spawn and outbound HTTP, both already documented as unreachable offline. |
| `database.rs`, `logger.rs`, `file_manager.rs`, `yt_dlp/events.rs` | 33 | Pool construction, log writing, handing a path to the OS file manager, emitting an event. |
| `commands/*.rs` | 12 | Command glue over services that are themselves in scope. |
| everything else | 28 | Single survivors spread thin, all of the same kinds. |

Two conclusions worth keeping. **The gate is not missing a module that carries real decisions**: the
one file that did (`utils/io.rs`) is in it now, and the pure logic elsewhere had already been pulled
out into files the gate covers, which is the extraction habit paying off rather than an accident.
And **a survivor count is not a quality signal on its own**: 265 of them here describe how much of
this crate is glue around a process, a handle or a socket, not how weak its tests are.

`models/yt_dlp.rs::ImportMode::as_str` is the one survivor deliberately left alone rather than
gated: two mutants, one caller, and what it decides is the word a log line uses. A test module for
it would be the "a directory per pair" mistake in another form.

### What the `media_page.rs` pass did not establish

A clean first measurement invites the wrong conclusion, so this one is written down. The file is
covered because of `every_media_page_sort_is_served_by_an_index`, a test written for a different
purpose (index coverage), not because each clause is pinned on its own. A sixth sort category added
later with no index would be caught by that same test; one added *with* an index but the wrong
direction would not be, and this gate would not see it either. Mutants are generated from the arms
that exist, never from the one somebody forgot to add.

### The one excluded file

`db_backup/test_support.rs` holds the family's test fixtures. It is a `#[cfg(test)] mod`, so a
mutant in it can only make a fixture wrong, and a wrong fixture is a red suite, which is the opposite
of the undetected regression this gate looks for. The directory glob stays a glob (that is what
keeps a future submodule split in scope with nothing to remember), so the one file that should not be
in it is named in `exclude_globs` instead.

**Not measured**, and stated as such rather than left to read like the rows above: cargo-mutants may
already skip it by following the `cfg(test)` on the module declaration. A redundant exclusion costs
nothing; the reverse would put unkillable noise in a weekly run. Drop it if a `--list` ever shows it
was never needed.

## Exclusions

Every entry in `exclude_re`, by the reason it is there. What stays in scope regardless is the
security logic itself: `sanitize_relative_path_strict`, `ensure_managed_library_relative_path` and
the containment helpers, `is_allowed_youtube_url` / `is_allowed_youtube_host`, and
`paths_refer_to_same_location`.

### Equivalent mutants

No input distinguishes the mutated code from the original, so no test can kill it.

| Pattern | Why |
|---|---|
| `replace < with <= in read_drain_capped_async` | The extra iteration `<=` admits is the one where `buffer.len()` equals `max_bytes`, and there `max_bytes - buffer.len()` is 0, so the `extend_from_slice` copies nothing. Same buffer, same drain. Its sibling on the next line (the `-` to `+`) is a real mutant and is deliberately left in scope. |
| `replace < with <= in read_lossy_line_capped` | The same argument as the entry above, for the same shape in `utils/io.rs`, and it covers both branches (the one that found a newline and the one that did not). Their `-` to `+` siblings are likewise left in scope, and are killed by the two tests that read through a small-capacity `BufReader` so a chunk straddles the cap. |
| `delete ! in remove_old_library_contents` | The guard decides only whether a `logger::warn` naming the leftover entries is emitted. The removal has already happened and the list is the value being reported. Precise rather than broad: the only other mutant in that function reads differently and is caught. |
| `report_cleanup_outcome` | Writes a `logger::warn` and does nothing else. The cleanup has already run and its outcome is the report being matched on. The bare name covers both the `with ()` mutant and the `failed_paths` guard mutants, which are the same argument twice. |
| `replace \|\| with && in paths_refer_to_same_location` | With `&&`, one empty input still returns false: `canonicalize("")` always errors and an empty string never equals a non-empty one, so the fallback compare yields the same false. |
| `replace \|\| with && in file_paths_have_same_content` | With `&&`, a missing or non-file path still returns `Ok(false)`, because the next guard (or the hash of a non-file) yields the same result. The directory-vs-file case it defends has no caller. Covers both the `exists()` and `is_file()` guards. |
| `delete ! in build_temp_destination_path` | Changes only the internal temp filename, which the following rename discards. |
| `replace > with (==\|<\|>=) in apply_migration_13` and `_14` | Both `> 0` guards gate nothing but a `logger::warn` counting the rows the migration repaired. The repair is the `UPDATE` above, which runs unconditionally, and the counts stay covered by the migration tests. |
| `replace > with (==\|<\|>=) in verify_library_content_sync` | The same argument as the two migration guards above, on the `report.corrupt > 0` line in front of a `logger::warn`. All three weakenings return a byte-identical report; only whether the line is written changes. `logger::write` returns early when `LOG_PATH` is unset, and nothing sets that `OnceLock` in a unit test (only `init`, from the app log dir), so there is no in-process observer to assert against. Narrow on purpose: the rest of that function, both cancel checks and the loop, stays in scope and is killed. Worth naming the one thing this concedes, since "equivalent" overstates it slightly: the `>=` form would have every clean run log "found 0 file(s) whose bytes do not match", which is noise in the file the README asks users to attach to a bug report. Not wrong output, and not something a test can currently see. |
| `replace && with \|\| in run_full_integrity_check`, `replace > with (==\|<\|>=) in run_full_integrity_check` | Need a corrupt database returning a *controlled* number of problem rows. Against the multi-row result the damaged-database test produces, these operators are equivalent. The one-week throttle is not excluded; it is covered by `integrity_check_is_not_due_within_the_weekly_throttle_window`. |
| `replace < with <= in needs_migration` | Re-runs the migration the database is already at. Every migration is idempotent by construction and each stamps the version it re-applied, so the end state is byte-identical and only the work is wasted. **The `== N` direction is deliberately not excluded**: that one skips a migration outright, which is a real defect, and it survived until 2026-07-28 because reaching head was the only thing asserted. `every_historical_version_migrates_to_the_current_schema` now asserts every index and trigger exists after migrating from each historical version. |

### Boundaries a unit test cannot pin

The function reads the process environment, spawns a child, or touches a filesystem state no
deterministic test can arrange.

| Pattern | Why |
|---|---|
| `is_executable_file`, `resolve_from_path`, `resolve_binary_from_candidates`, `resolve_yt_dlp_binary`, `resolve_ffmpeg_binary`, `run_command_and_capture_first_line`, `validate_yt_dlp_binary`, `validate_ffmpeg_binary`, `resolve_external_tools_status` | `binaries.rs` boundary functions: they read `PATH`, spawn `--version` health checks, or resolve app directories from the `AppHandle`. The no-CWD guarantee stays covered directly by `resolve_from_path_var_only_searches_listed_directories` and the PATHEXT test. |
| `generate_display_thumbnail` | Spawns FFmpeg and polls it to a deadline. Its four survivors are the return value and the deadline arithmetic, which need a real FFmpeg to distinguish. |
| `replace wait_with_capped_output`, `run_thumbnail_yt_dlp_with_timeout` | The two halves of the thumbnail spawn that need a live child: one takes its pipes, the other kills its process tree on a deadline. Deliberately narrow. `read_drain_capped_async`, which is where the cap arithmetic lives, stays in scope and is tested directly against a counting reader. |
| `error.kind() == std::io::ErrorKind::NotFound.* in (read_pending_markers\|clear_pending_media_artifacts)`, `replace == with != in read_pending_markers` | Unreachable rather than merely hard: `pending_media_dir` runs `create_dir_all` before returning, so the `read_dir` never sees a missing directory, and `clear_pending_media_artifacts` treats an already-removed marker as success. Forcing a different io error deterministically and cross-platform is not something a unit test can do. |
| `replace pin_process_start with ()` | Initializes a process-global `OnceLock` while the launch instant is still accurate. Any test that reads `process_start()` initializes the same `OnceLock`, and there is no second process to compare against. Genuinely unkillable in-process. |
| `replace && with \|\| in copy_file_atomic` | The failed-rename recovery branch, reachable only when the temp-to-destination rename itself fails. |
| `error.kind() == ErrorKind::NotFound.* in replace_file_safely`, `replace == with != in replace_file_safely` | The backup-vanished race: needs the destination to disappear between the exists check and the rename. |
| `replace && with \|\| in stage_database_import`, `replace != with == in stage_database_import`, `replace > with (==\|<\|>=) in stage_database_import` | The WAL-checkpoint "still in use" branch (`busy != 0 && frames > 0`) needs a second connection holding a lock on the source during the import. The valid path is exercised by the import tests. |

### Mutants the suite catches, but only as a hang

A category of one file so far, and the distinction it draws is worth keeping separate from the two
above: these are **not** survivors and **not** equivalent. The suite does detect them. It just has
no way to say so, because the mutation stops a reader consuming what it read, so
`yt_dlp::metadata`'s `while let Some(line) = read_lossy_line(..)` never terminates. cargo-mutants
waits out the 300-second deadline and reports a timeout, which fails the weekly run for a reason
that has nothing to do with test strength, and costs five minutes apiece to learn nothing.

| Pattern | Why |
|---|---|
| `replace read_lossy_line(_capped)? -> Option<String> with Some(String::new())` | Both spellings return a line forever without advancing the reader. The two `#[tokio::test]`s that assert the *first* line's contents do fail on them, so the mutation is caught in the ordinary sense; the run still sits until the deadline because a sibling test is spinning. |
| `replace + with [-*] in read_lossy_line_capped` | `reader.consume(newline_pos + 1)` is what steps past the terminator. With `- 1` or `* 1` the same newline is found on every pass, so the loop never leaves the function at all, and no assertion anywhere can fire. |

### Bodies compiled only on another platform

cargo-mutants does not evaluate `cfg`, so on any single platform the other body is reported as an
unkillable survivor and the gate could never be green cross-platform. The gate runs on ubuntu.

| Pattern | Why |
|---|---|
| `is_cross_device_error` | EXDEV detection is cfg-split (unix errno 18 / windows 17) and needs a real cross-device rename. The name also matches the match-guard mutants in `move_or_copy_file` that call it. |
| `fsync_parent_dir` | cfg-split (unix `File::sync_all` / windows `FlushFileBuffers`), best effort, and its only effect is invisible to any functional test. |
| `is_batch_shim_extension` | `#[cfg(windows)]`, and so is the test that pins it. The BatBadBut guard stays covered by `is_batch_shim_extension_flags_only_bat_and_cmd`, which runs on Windows. |
| `replace dir_entry_is_symlink -> bool with false` | The symlink-cycle test is `cfg(unix)` (creating a symlink on Windows needs privilege). Its `-> true` counterpart stays in scope, since a plain copy test catches that on every platform. |
| `in to_extended_length_path`, `replace to_extended_length_path -> PathBuf with Default::default()` | `library/paths.rs`: the `\\?\` rewrite is a `#[cfg(windows)]` body with a `#[cfg(not(windows))]` pass-through, so each platform reports the other body as missed (the Windows measurement missed the pass-through; the ubuntu gate would miss the whole Windows body). The Windows body is pinned by three `cfg(windows)` tests that run in the Windows test job. Narrow on purpose: `library_input_path`, which calls it, and every helper built on it stay in scope. |

### `AppHandle`-bound glue

These need a live handle to reach the shared pool, the library or the cache directory, none of which
exists under the unit-test harness. They are reported *viable* rather than unviable because the
function still compiles when replaced; what cannot be built is a test that calls it.

| Pattern | Why |
|---|---|
| `replace cleanup_artifacts_best_effort(_locked)? with ()`, `replace record_marker_best_effort -> Option<String>`, `replace clear_marker_best_effort with ()` | `media_creation.rs` glue. The decisions that matter were extracted into pure functions and are in scope and covered. |
| `in sweep_pending_media_artifacts` | Needs a live handle and the shared pool to reach the reference-counting cleanup. The decision that matters, `marker_is_sweepable`, is pure, in scope and covered. The `\|\|` filter in `read_pending_markers` is deliberately *not* excluded. |
| `configured_library_dir`, `ensure_configured_library_path`, `verify_library_path_then_blocking` | Guard entrypoints needing the pool and the settings row. The pure comparison they delegate to, `paths_refer_to_same_location`, stays in scope and tested. |
| `replace register_cache_asset_scope with ()` | What is left of that function once the half with an observable effect was extracted into `prepare_cache_scope_dirs`. Narrow on purpose: `prepare_cache_scope_dirs`, `managed_cache_scope_dirs` and `grant_path_with_canonical` all stay in scope. |

### One exclusion that was reasoned wrongly, kept as a note

`thumbnail/display.rs`'s `resolve_display_thumbnails_sync` has **no** exclusion, and the reason this
file used to give for one was wrong. It said that being `AppHandle`-bound made its mutants unviable
rather than missed. Unviable means the mutated tree does not *compile*, which has nothing to do with
whether a test can reach the function, so a comparison inside its body compiles fine and comes back
missed. The 2026-08-01 run duly reported `<` swapped for `>` and for `<=` on the truncation guard.
The fix was to extract that comparison (`request_was_truncated`), not to exclude it. Recorded because
the same mistaken reasoning would readmit the next one.
