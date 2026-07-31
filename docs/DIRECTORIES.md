# Runtime directories

Kavynex writes to four kinds of locations on disk: Tauri's standard per-OS app
directories (config, cache, log), and a user-chosen "library" directory that holds the
actual backed-up media. This document describes what lives where, grounded in
`src-tauri/src/lib.rs` and the `services/` modules that call `tauri::path`.

The app identifier is `com.kavynex.app` (`src-tauri/tauri.conf.json`), which Tauri appends
to each platform's base directory. The exact per-OS base paths below follow Tauri v2's
documented `app_config_dir`/`app_data_dir`/`app_cache_dir`/`app_log_dir` resolution;
verify the precise path on your OS with the in-app Diagnostics dialog or by checking
`tauri::path` in a debugger if you need to be certain, since it is not something this
codebase re-implements or overrides.

## App config directory - the database

`services/database.rs::database_path()` resolves the database file via
`app.path().app_config_dir()`, creating the directory if missing, and joins
`kavynex.db`:

- Windows: `%APPDATA%\com.kavynex.app\kavynex.db` (i.e. `FOLDERID_RoamingAppData`)
- macOS: `~/Library/Application Support/com.kavynex.app/kavynex.db`
- Linux: `~/.config/com.kavynex.app/kavynex.db` (or `$XDG_CONFIG_HOME` if set)

Alongside `kavynex.db`, SQLite's WAL mode (see `docs/DATABASE.md`) creates sidecar files
`kavynex.db-wal` and `kavynex.db-shm` in the same directory while the app is running.
The backup/restore/import machinery in `services/db_backup/` also writes siblings here:

- `kavynex.db.bak` plus `kavynex.db.bak.1` .. `kavynex.db.bak.6` - the rotated automatic
  snapshots (`BACKUP_ROTATED_GENERATIONS` = 6, so up to seven exist). More than one is kept
  because the newest can itself have captured an already-degrading database.
- `kavynex.db.corrupt` plus `kavynex.db.corrupt.1` .. `kavynex.db.corrupt.2` - databases moved
  aside after a failed restore, rotated the same way so a repeated restore keeps the earlier
  evidence. Fewer generations than `.bak`: each is a full copy of an already-broken database.
- `kavynex.db.pre-import` - the database as it was before the last applied import, kept so the
  import can be undone. It persists until the next import replaces it.
- `kavynex.db.integrity-checked` - an empty marker whose mtime records the last time the background
  full `integrity_check` passed. It throttles that check to once a week (`db_backup/integrity.rs`); the
  automatic paths use the faster `quick_check`, and this thorough one runs off the startup critical
  path to catch subtler damage a `quick_check` would pass.
- Short-lived scratch files, present only during the corresponding operation: `.bak.tmp`
  (the snapshot being vacuumed, before it is promoted to `.bak`), `.import-staged` /
  `.import-staged.tmp` (an import waiting for the next startup), `.import-applying` (see
  below), `.restore.tmp` (a snapshot being restored), `.corrupt.tmp` (a database being moved
  aside), and `.export-staging` next to a chosen *export* destination rather than here.

`.import-applying` is written once an import has moved the current database aside into
`.pre-import`, and removed once the swap (or its rollback) has put a database back in place, so it
only ever outlives a startup when the swap died in between. Finding it there, with a `.pre-import`
beside it, is what tells the next launch that snapshot holds the *only* copy of the database and
must be kept rather than consumed - on disk that state is otherwise indistinguishable from a normal
second import. If you ever see one sitting next to `kavynex.db` on a healthy install, an import
failed midway and `.pre-import` is the database to go back to. See `docs/DATABASE.md` for why it is
written after the move-aside rather than before it.

See `docs/DATABASE.md` for the rotation, restore and import rules these files follow - the
counts above are `BACKUP_ROTATED_GENERATIONS` / `CORRUPT_ROTATED_GENERATIONS` in
`db_backup/snapshot.rs` and `db_backup/restore.rs`, which is what to read if this list and the code
ever disagree.

Those counts bound how *many* snapshots exist, never how *large* they get, and each `.bak`,
`.corrupt` and `.pre-import` is a full copy of the database - which grows with every comment
backed up. Up to eleven such copies can therefore sit in this one directory. Because that is not
otherwise visible anywhere (and on Windows this is the roaming profile), **Settings > Database**
reports the total these files currently occupy alongside the date of the last automatic snapshot;
`db_backup/mod.rs::managed_database_paths` is the set it sums. It stayed in `mod.rs` when the
snapshot and restore machinery moved into submodules of their own, because it is the one thing there
that has to know about all of them at once.

All of the snapshots above sit on the same volume as the live database, so a disk failure takes
them with it. The **optional** external backup (Settings > Database) addresses that: when a folder
is configured (`external_backup_dir` in `app_settings`), `db_backup/external.rs::mirror_database_to_external_dir`
writes `kavynex-backup.db` there once a day, rotated as `kavynex-backup.db.1` /
`kavynex-backup.db.2` (`EXTERNAL_BACKUP_ROTATED_GENERATIONS` = 2), via the same atomic
`export_database`. Only the database is mirrored - the media files are not - and the folder is left
untouched when it is unreachable (an unplugged drive) rather than recreated.

Note that on Windows and macOS, Tauri's `app_config_dir` and `app_data_dir` resolve to
the *same* directory; on Linux they differ (`~/.config/...` vs `~/.local/share/...`).
`services/binaries.rs`'s optional `tools/` fallback folder for yt-dlp/ffmpeg (see the
README's Troubleshooting section) uses `app_data_dir`, so on Linux it lives in a
different directory than the database - verify the exact split on your distribution if
this matters to you.

## App cache directory - temporary previews

`app.path().app_cache_dir()` is used for short-lived, regenerable files:

- Windows: `%LOCALAPPDATA%\com.kavynex.app`
- macOS: `~/Library/Caches/com.kavynex.app`
- Linux: `~/.cache/com.kavynex.app` (or `$XDG_CACHE_HOME` if set)

`services/temp_paths.rs` creates four subdirectories under the cache dir (names defined
in `src-tauri/src/constants.rs`). Three of them hold pure scratch:

- `thumbs-temp/` - temporary thumbnail previews generated before a thumbnail is committed
  to the library (`services/thumbnail/temp.rs`), named `thumb_<sha256>.jpg` - the container
  both thumbnail producers share (`THUMBNAIL_OUTPUT_FORMAT` in `src-tauri/src/constants.rs`).
- `yt-dlp-temp/` - scratch space for an in-progress yt-dlp download before its output is
  moved into the library.
- `yt-dlp-thumb-temp/` - scratch space for thumbnails fetched as part of a yt-dlp run.

A fourth, `thumb-display/`, holds something different from scratch data: a **display-sized copy** of
each thumbnail the grid has drawn (`services/thumbnail/display.rs`), named
`<sha256-of-the-stored-thumbnail>-w<width>.jpg`. The width is in the name so that changing
`DISPLAY_THUMBNAIL_MAX_WIDTH` invalidates the cache: nothing revalidates a cached file's dimensions,
so a name without it would keep serving the old size indefinitely. A stored thumbnail keeps whatever
size it arrived at - a
yt-dlp `maxresdefault` is 1280x720 - and a webview decodes an image at its natural size regardless
of how well the file is compressed, so drawing one into a card a few hundred pixels wide costs the
full bitmap. These copies are capped at `DISPLAY_THUMBNAIL_MAX_WIDTH` (640) so the card decodes a
quarter of that.

Nothing in the database refers to them. `videos.thumbnail_path` and `channels.avatar_path` still
point at the canonical file in the library; a derivative is addressed *by* that file's own content
hash, which is already in its name, so the mapping needs no storage. That is also why the cache is
safe to delete at any time: a missing entry is regenerated the next time the grid asks, and a
thumbnail that has been in the library for years gets one the first time it is drawn. If FFmpeg is
not available, or the source has moved, the grid simply draws the stored file as it always did.

Being derived rather than scratch is also why this one is **not** swept by age like the three above.
Regenerating a derivative costs an FFmpeg process, and a cache *hit* is a `stat` that renews nothing,
so an age rule discarded the thumbnails the grid draws every day at the same rate as the ones nothing
had looked at since they were written - emptying the whole cache every seven days and paying it back
as a burst of FFmpeg runs on the next scroll. It is bounded by total size instead
(`DISPLAY_CACHE_MAX_BYTES` in `services/thumbnail/display.rs`): a cache that fits is left entirely
alone whatever its age, and one that does not is trimmed oldest-first until it fits.

A fifth, `pending-media/`, is created by `services/pending_media.rs` rather than
`temp_paths.rs`, and holds something different again: one `pending-*.json`
marker per media creation that has already written its artifacts into the library but has
not yet inserted the row. Adding media is not a single call, and between those two steps
the files exist with nothing pointing at them - so the marker names them. It is removed as
soon as the row lands (or the failure path has cleaned the artifacts up), which means a
marker left over from an *earlier* run is a creation the process did not survive.

`lib.rs`'s `spawn_pending_media_sweep` reconciles those shortly after launch by handing the
paths to the same reference-counting cleanup the Diagnostics path uses, so an artifact a
registered row still points at is kept and only a genuine orphan is removed. Finding a
`pending-media/` marker on a healthy install means a media import died midway; the sweep
handles it on the next launch and nothing needs to be deleted by hand.

The sweep runs on a short delay rather than inline with startup, so "still present" is not by
itself enough to act on: a marker written by a creation the user started *after* launch is
also present, and its row has legitimately not been inserted yet. Consuming it would unlink
the file being added right now. So the sweep only considers a marker that is neither
registered as in flight by this process nor newer than the process itself
(`pending_media::marker_is_sweepable`), and every uncertain case is left in place - one launch
later is a cheaper mistake than deleting a file the user still wants.

A marker whose reconciliation *fails* is kept for the next launch to retry, since the usual cause is
transient (the library drive not mounted yet). Nothing there can tell transient from permanent, so
the marker carries an `attempts` count and is abandoned after `MAX_MARKER_SWEEP_ATTEMPTS` (5) - a
failure that survives five launches is not a slow drive. Abandoning it means the *record* is given
up on, never the files: the marker stays on disk and its artifacts stay in the library, where the
Diagnostics dialog reports them as unreferenced. The difference is that the failure is logged once,
at error level with its count, instead of at warning level on every launch forever.

Two things have to happen together for that to be true, and they are in different functions. The
incremented count is written back to the marker on *every* failure, including the one that reaches
the ceiling; and `read_pending_markers` drops a marker whose count is already at the ceiling before
the sweep ever sees it. With only the first, an abandoned marker sits at five and is re-read on
every launch. With only the second, it sits at four and never reaches five. Either way the sweep
would retry the same failing cleanup and re-emit the notice below on every launch - which is worse
than the unbounded warning line the ceiling replaced, because that one at least stayed in the log.

Giving up is surfaced to the user once, as a notice pointing at Diagnostics
(`EVENT_PENDING_MEDIA_ABANDONED`, one event per sweep however many markers it covered), rather than
being left to the log file alone.

On startup, `lib.rs`'s `setup()` authorizes `thumbs-temp/` and `thumb-display/` - and only those
two - in the Tauri asset-protocol scope (`commands/security.rs::register_cache_asset_scope`, see
`THREAT-MODEL.md`), so a thumbnail preview can be shown in the webview via `convertFileSrc` before it is
persisted and a display derivative can be drawn by the grid. The cache **root** is deliberately not
granted: on Windows it is the parent of the `logs` directory described below and of the WebView2
profile (`EBWebView/`), and the other three subdirectories here are read by the backend alone. A
background task
(`services::cleanup::cleanup_stale_temp_files_sync`, spawned from `lib.rs`) sweeps the cache
directory on every startup, and the rule it applies depends on what a directory holds:

- The three scratch directories (`thumbs-temp/`, `yt-dlp-temp/`, `yt-dlp-thumb-temp/`) lose any
  entry older than 7 days (`TEMP_ENTRY_MAX_AGE_HOURS = 24 * 7` in `services/cleanup.rs`), so an
  interrupted download/thumbnail generation does not leak disk space indefinitely.
- `thumb-display/` is bounded by total size instead, for the reason given above.
- `pending-media/` is swept by neither: its markers are reconciled by
  `spawn_pending_media_sweep`, which decides per marker (see `marker_is_sweepable`) rather than
  by age, and a marker it cannot reconcile is deliberately kept.

## App log directory - `kavynex.log`

`app.path().app_log_dir()` is where `services/logger.rs` writes:

- Windows: `%LOCALAPPDATA%\com.kavynex.app\logs`
- macOS: `~/Library/Logs/com.kavynex.app`
- Linux: `~/.local/share/com.kavynex.app/logs` (under `app_data_dir`, or `$XDG_DATA_HOME`)

The logger writes to stderr always, and additionally appends to `kavynex.log` in that
directory once `services::logger::init()` has been called from `lib.rs`'s `setup()`. Log
lines are `[<RFC 3339 UTC timestamp>] [<LEVEL>] [<scope>] <message>` (for example
`[2026-07-06T12:34:56Z] [INFO] [app] application setup finished`). When the file passes 5 MB
(`MAX_LOG_BYTES`), it is rotated: the existing file becomes `kavynex.log.1` (replacing any
previous rotation) and a fresh `kavynex.log` is started - so at most two generations are
ever kept.

## The library directory

The library directory is user-chosen (persisted as `library_path` in `app_settings`; see
`docs/DATABASE.md`) and defaults, on first run, to `<video_dir>/Kavynex Library`
(`services/library/paths.rs::resolve_default_library_directory_sync`, using Tauri's
platform `video_dir()` - e.g. `~/Videos/Kavynex Library` on Linux/macOS,
`%USERPROFILE%\Videos\Kavynex Library` on Windows). Unlike the app-owned directories
above, the user can point this anywhere via Settings, and `services/library/migration.rs`
supports moving its contents when the path changes.

Inside the library directory, media services create these subfolders on demand:

- `video/` - imported/downloaded video files.
- `audio/` - imported/downloaded audio-only files.
- `thumbnails/` - persisted thumbnail images.
- `live_chat/` - gzip-compressed live chat replay JSON (`.json.gz`), one file per video
  that has live chat backed up.

### Filenames

Two different naming schemes are used, depending on how a file enters the library.

**Content-addressed (local imports and thumbnails).** These files are named after the
SHA-256 hash of their own content (`utils/hash.rs::file_hash`, computed by streaming the
file rather than loading it whole):

- `video/media_<sha256>.<ext>` or `audio/media_<sha256>.<ext>` - a **locally imported**
  file, written by `services/library/media.rs::import_media_file_sync`.
- `thumbnails/thumb_<sha256>.<ext>` - written by `services/thumbnail/persist.rs`.

This makes storage naturally deduplicated (two imports of byte-identical content produce
the same filename) and content-verifiable (the filename itself is a checksum). It also
means renaming or re-encoding a file outside the app changes its hash and therefore its
expected filename - this is exactly what the library-integrity diagnostics
(`services/library/cleanup.rs`, `services/library/summary.rs`, surfaced by the
Diagnostics dialog) check for.

**Identifier-based (yt-dlp downloads).** A file downloaded via yt-dlp is *not*
content-hashed (hashing a multi-GB download would be wasteful and pointless, since the
video id already identifies it). It is named from the source metadata as
`<extractor>_<id>_<format_id>.<ext>` (e.g. `youtube_dQw4w9WgXcQ_137.mp4`), where each
component is passed through `services/yt_dlp/metadata.rs::sanitize_filename_component`;
see `build_download_command_args` in `services/yt_dlp/download/command.rs` and
`place_downloaded_file` in `services/yt_dlp/download/mod.rs`. This name is deterministic
for a given video+format, and the download path never overwrites an existing destination,
so re-downloading the same
video+format keeps the already-catalogued bytes rather than replacing them with a
re-encode. One consequence worth knowing: because the two schemes differ, downloading a
video via yt-dlp and *separately* importing the same file locally produces two distinct
on-disk copies (there is no cross-scheme deduplication) - within a single scheme, dedup
still holds.

Live chat files are likewise named from the video/run rather than content-hashed (they are
written once by a yt-dlp run and not re-derived); see `services/yt_dlp/download/mod.rs` and
`services/live_chat_storage.rs` for the exact naming if you need to trace a specific file.

All paths stored in the database (`videos.file_path`, `videos.thumbnail_path`,
`videos.live_chat_file_path`, `channels.avatar_path`) are relative to the library
directory, never absolute - so the library can be moved or the app data relocated without
invalidating every row. `utils/path.rs` is what enforces that any relative path used this
way stays inside the library directory (see `THREAT-MODEL.md`).
