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
The backup/restore/import machinery in `services/db_backup.rs` also writes siblings here:

- `kavynex.db.bak` plus `kavynex.db.bak.1` .. `kavynex.db.bak.6` - the rotated automatic
  snapshots (`BACKUP_ROTATED_GENERATIONS` = 6, so up to seven exist). More than one is kept
  because the newest can itself have captured an already-degrading database.
- `kavynex.db.corrupt` plus `kavynex.db.corrupt.1` .. `kavynex.db.corrupt.2` - databases moved
  aside after a failed restore, rotated the same way so a repeated restore keeps the earlier
  evidence. Fewer generations than `.bak`: each is a full copy of an already-broken database.
- `kavynex.db.pre-import` - the database as it was before the last applied import, kept so the
  import can be undone. It persists until the next import replaces it.
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
`db_backup.rs`, which is what to read if this list and the code ever disagree.

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

`services/temp_paths.rs` creates three subdirectories under the cache dir (names defined
in `src-tauri/src/constants.rs`):

- `thumbs-temp/` - temporary thumbnail previews generated before a thumbnail is committed
  to the library (`services/thumbnail_temp.rs`), named `thumb_<sha256>.png`.
- `yt-dlp-temp/` - scratch space for an in-progress yt-dlp download before its output is
  moved into the library.
- `yt-dlp-thumb-temp/` - scratch space for thumbnails fetched as part of a yt-dlp run.

On startup, `lib.rs`'s `setup()` authorizes the whole cache directory in the Tauri
asset-protocol scope (see `SECURITY.md`) so these temporary files can be shown in the
webview via `convertFileSrc` before they are persisted. A background task
(`services::cleanup::cleanup_stale_temp_files_sync`, spawned from `lib.rs`) sweeps these
temp directories on every startup and removes entries older than 7 days
(`TEMP_ENTRY_MAX_AGE_HOURS = 24 * 7` in `services/cleanup.rs`), so an interrupted
download/thumbnail generation does not leak disk space indefinitely.

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
(`services/library_paths.rs::resolve_default_library_directory_sync`, using Tauri's
platform `video_dir()` - e.g. `~/Videos/Kavynex Library` on Linux/macOS,
`%USERPROFILE%\Videos\Kavynex Library` on Windows). Unlike the app-owned directories
above, the user can point this anywhere via Settings, and `services/library_migration.rs`
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
  file, written by `services/library_media.rs::import_media_file_sync`.
- `thumbnails/thumb_<sha256>.<ext>` - written by `services/thumbnail_persist.rs`.

This makes storage naturally deduplicated (two imports of byte-identical content produce
the same filename) and content-verifiable (the filename itself is a checksum). It also
means renaming or re-encoding a file outside the app changes its hash and therefore its
expected filename - this is exactly what the library-integrity diagnostics
(`services/library_cleanup.rs`, `services/library_summary.rs`, surfaced by the
Diagnostics dialog) check for.

**Identifier-based (yt-dlp downloads).** A file downloaded via yt-dlp is *not*
content-hashed (hashing a multi-GB download would be wasteful and pointless, since the
video id already identifies it). It is named from the source metadata as
`<extractor>_<id>_<format_id>.<ext>` (e.g. `youtube_dQw4w9WgXcQ_137.mp4`), where each
component is passed through `services/yt_dlp_metadata.rs::sanitize_filename_component`;
see `build_download_command_args`/`place_downloaded_file` in
`services/yt_dlp_download.rs`. This name is deterministic for a given video+format, and
the download path never overwrites an existing destination, so re-downloading the same
video+format keeps the already-catalogued bytes rather than replacing them with a
re-encode. One consequence worth knowing: because the two schemes differ, downloading a
video via yt-dlp and *separately* importing the same file locally produces two distinct
on-disk copies (there is no cross-scheme deduplication) - within a single scheme, dedup
still holds.

Live chat files are likewise named from the video/run rather than content-hashed (they are
written once by a yt-dlp run and not re-derived); see `services/yt_dlp_download.rs` and
`services/live_chat_storage.rs` for the exact naming if you need to trace a specific file.

All paths stored in the database (`videos.file_path`, `videos.thumbnail_path`,
`videos.live_chat_file_path`, `channels.avatar_path`) are relative to the library
directory, never absolute - so the library can be moved or the app data relocated without
invalidating every row. `utils/path.rs` is what enforces that any relative path used this
way stays inside the library directory (see `SECURITY.md`).
