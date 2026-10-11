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

## App config directory. The database

`services/database.rs::database_path()` resolves the database file via
`app.path().app_config_dir()`, creating the directory if missing, and joins
`kavynex.db`:

- Windows: `%APPDATA%\com.kavynex.app\kavynex.db` (i.e. `FOLDERID_RoamingAppData`)
- macOS: `~/Library/Application Support/com.kavynex.app/kavynex.db`
- Linux: `~/.config/com.kavynex.app/kavynex.db` (or `$XDG_CONFIG_HOME` if set)

Alongside `kavynex.db`, SQLite's WAL mode (see `docs/DATABASE.md`) creates sidecar files
`kavynex.db-wal` and `kavynex.db-shm` in the same directory while the app is running.
The backup/restore/import machinery in `services/db_backup/` also writes siblings here:

- `kavynex.db.bak` plus `kavynex.db.bak.1` .. `kavynex.db.bak.6`: the rotated automatic
  snapshots (`BACKUP_ROTATED_GENERATIONS` = 6, so up to seven exist). More than one is kept
  because the newest can itself have captured an already-degrading database.
- `kavynex.db.corrupt` plus `kavynex.db.corrupt.1` .. `kavynex.db.corrupt.2`: databases moved
  aside after a failed restore, rotated the same way so a repeated restore keeps the earlier
  evidence. Fewer generations than `.bak`, since each is a full copy of an already-broken database.
- `kavynex.db.pre-import`: the database as it was before the last applied import, kept so the
  import can be undone. It persists until the next import replaces it.
- `kavynex.db.pre-migration-v<N>`: the database as it was right before an upgrade migrated it from
  schema version N. Taken every time a migration is pending, never throttled or rotated by the
  daily snapshot, and the two most recent are kept (`PRE_MIGRATION_SNAPSHOTS_KEPT`). It is the copy
  to go back to after a migration that went wrong, or after installing an older version, which
  cannot open a database a newer one migrated. The restore offered after a failed start tries it
  after the daily snapshots. Going back to it from a database that still opens means closing
  Kavynex and copying it over `kavynex.db` by hand.
- `kavynex.db.integrity-checked`: an empty marker whose mtime records the last time the background
  full `integrity_check` passed. It throttles that check to once a week (`db_backup/integrity.rs`); the
  automatic paths use the faster `quick_check`, and this thorough one runs off the startup critical
  path to catch subtler damage a `quick_check` would pass.
- `kavynex.db.integrity-failed`: an empty marker a full `integrity_check` that found damage leaves,
  and a passing check or a database swap removes. While it is there the daily snapshot does not
  rotate, the external mirror does not rotate either, and compaction is refused.
- `kavynex.db.after-damage`: the daily copy of the database taken while `.integrity-failed` is there,
  in place of a new generation. One file, replaced at most once a day, never restored automatically
  and never removed. It holds what was added after the damage, which the generations from before it
  do not.
- `kavynex.db.swapped-at`: when an import, its undo or a restore last replaced the database, in
  seconds since the epoch. The orphan removal refuses for 30 days after it. The set-aside database's
  own modification time is consulted alongside it, since it is never newer than the swap that set it
  aside, and either one answering recent is enough. Start empty records a swap too.
- `kavynex.db.lineage`: an id given to a database created from nothing (a first run, a reinstall,
  Start empty). The external mirror labels its copies with it, so a later database can tell the copies
  an earlier one left in the folder and set them aside instead of rotating them out
  (`db_backup/lineage.rs`). A database older than this file has none.
- `set-aside-backups/<UTC time>/`: the snapshots that were here when Start empty was chosen, renamed
  to `kavynex-bak.db`, `kavynex-bak-1.db`, `kavynex-pre-migration-v15.db` and so on so Settings >
  Database > Import reads them directly. Nothing deletes this folder. Diagnostics reports it and opens
  it.
- Short-lived scratch files, present only during the corresponding operation: `.bak.tmp`
  (the snapshot being vacuumed, before it is promoted to `.bak`), `.after-damage.tmp` (the same for
  `.after-damage`), `.import-staged` /
  `.import-staged.tmp` (an import waiting for the next startup), `.import-applying` (see
  below), `.restore.tmp` (a snapshot being restored), `.corrupt.tmp` (a database being moved
  aside), and `.export-staging` next to a chosen *export* destination rather than here.

`.import-applying` is written once an import has moved the current database aside into
`.pre-import`, and removed once the swap (or its rollback) has put a database back in place, so it
only ever outlives a startup when the swap died in between. Finding it there, with a `.pre-import`
beside it, is what tells the next launch that snapshot holds the *only* copy of the database and
must be kept rather than consumed, on disk that state is otherwise indistinguishable from a normal
second import. If you ever see one sitting next to `kavynex.db` on a healthy install, an import
failed midway and `.pre-import` is the database to go back to. See `docs/DATABASE.md` for why it is
written after the move-aside rather than before it.

A `kavynex.db.displaced-<suffix>` (and its `-wal`) is what such a recovery found at the database
path and set aside instead of deleting. It is a complete SQLite database. If it holds work you
expected to see, export the current database first, copy the displaced one (and its `-wal`, if any)
to a name ending in `.db` while Kavynex is closed, and import that copy through
Settings > Database > Import.

A `kavynex.db.displaced-<suffix>-wal` with no database of the same name beside it is a log that
a recovery found under the live name after the file it belonged to had already been set aside. It
is moved away so it is never replayed into the database renamed in next, and kept only as
evidence. On its own it is not a database to bring back.

One file here is not ours and is listed so the inventory above stays complete rather than
almost-complete:

- `.window-state.json`: the main window's size, position and maximized state, written by
  `tauri-plugin-window-state` when the app closes and read back on the next launch (see
  `docs/ARCHITECTURE.md` for where that plugin is registered). Kavynex never reads or writes it
  itself; the name and the location are the plugin's defaults, not something this codebase chooses,
  so treat the file on your machine as authoritative if it differs. Safe to delete at any time,
  since the next launch opens at the size in `src-tauri/tauri.conf.json` and writes a fresh one.

See `docs/DATABASE.md` for the rotation, restore and import rules these files follow. The
counts above are `BACKUP_ROTATED_GENERATIONS` / `CORRUPT_ROTATED_GENERATIONS` in
`db_backup/snapshot.rs` and `db_backup/restore.rs`, which is what to read if this list and the code
ever disagree.

Those counts bound how *many* snapshots exist, never how *large* they get, and each `.bak`,
`.corrupt`, `.pre-import` and `.pre-migration-v<N>` is a full copy of the database, which grows
with every comment backed up. Up to thirteen such copies can therefore sit in this one directory. Because that is not
otherwise visible anywhere (and on Windows this is the roaming profile), **Settings > Database**
reports the total these files currently occupy alongside the date of the last automatic snapshot;
`db_backup/mod.rs::managed_database_paths` is the set it sums. It stayed in `mod.rs` when the
snapshot and restore machinery moved into submodules of their own, because it is the one thing there
that has to know about all of them at once.

All of the snapshots above sit on the same volume as the live database, so a disk failure takes
them with it. Every generation, not just the newest. The seven `.bak` files and the `.corrupt` ones
are siblings of `kavynex.db`, so the rotation buys nothing against losing the disk. It is depth
against corruption, not against hardware.

Nor against the uninstaller, which is the third way this directory goes and the one no rotation
can answer. On Windows, the NSIS uninstaller's **Delete the application data** checkbox removes both
`%APPDATA%\com.kavynex.app` and `%LOCALAPPDATA%\com.kavynex.app`, so the database and all seven
generations go in one click. The checkbox is tauri-bundler's, not something this project added, and
its label names none of the above. `src-tauri/windows/hooks.nsh` puts a second confirmation in front
of it that does, and answering No keeps the directory while the app is still removed. The `.msi` has
no such option. `PRIVACY.md` states the consequence for the user.

**The external backup is what addresses that, and it is off unless you turn it on.** There is no
default folder and nothing prompts for one, so a fresh install has no off-volume copy at all, which
is worth stating plainly because the paragraph above otherwise reads as though the problem were
already solved. When a folder *is* configured (Settings > Database, stored as `external_backup_dir`
in `app_settings`), `db_backup/external.rs::mirror_database_to_external_dir` writes
`kavynex-backup.db` there once a day, rotated as `kavynex-backup.db.1` / `kavynex-backup.db.2`
(`EXTERNAL_BACKUP_ROTATED_GENERATIONS` = 2), via the same atomic `export_database`. Only the
database is mirrored (the media files are not), and the folder is left untouched when it is
unreachable (an unplugged drive) rather than recreated. Next to the copies sits
`kavynex-backup.lineage`, naming the database they were made from, and copies an earlier database
left there are renamed to `kavynex-backup-previous-<UTC time>[-N].db` and kept rather than rotated
out (see `docs/DATABASE.md`). While the database's last full check found damage the copies are not
rotated, and `kavynex-backup.after-damage.db` gets the day's copy instead.

What is at stake if it is left off is the metadata rather than the media. The comments, the live
chat, the titles, the publication dates and the channel/watched state all live only in the database,
and for a video that has since been removed from YouTube none of it can be fetched again. The media
files are the recoverable half, and `PRIVACY.md` is where that trade is stated for the user.

Note that on Windows and macOS, Tauri's `app_config_dir` and `app_data_dir` resolve to
the *same* directory; on Linux they differ (`~/.config/...` vs `~/.local/share/...`).
`services/binaries.rs`'s optional `tools/` fallback folder for yt-dlp, ffmpeg and deno (see the
`TROUBLESHOOTING.md`) uses `app_data_dir`, so on Linux it lives in a
different directory than the database. Verify the exact split on your distribution if
this matters to you.

## App cache directory. Temporary previews

`app.path().app_cache_dir()` is used for short-lived, regenerable files:

- Windows: `%LOCALAPPDATA%\com.kavynex.app`
- macOS: `~/Library/Caches/com.kavynex.app`
- Linux: `~/.cache/com.kavynex.app` (or `$XDG_CACHE_HOME` if set)

`services/temp_paths.rs` creates four subdirectories under the cache dir (names defined
in `src-tauri/src/constants.rs`). Three of them hold pure scratch:

- `thumbs-temp/`: temporary thumbnail previews generated before a thumbnail is committed
  to the library (`services/thumbnail/temp.rs`), named `thumb_<sha256>.jpg`. The container
  the FFmpeg preview and the yt-dlp avatar download convert to (`THUMBNAIL_OUTPUT_FORMAT` in
  `src-tauri/src/constants.rs`), and the one a downloaded media's thumbnail is fetched in, since
  YouTube serves every declared thumbnail as JPEG.
- `yt-dlp-temp/`: scratch space for an in-progress yt-dlp download before its output is
  moved into the library.
- `yt-dlp-thumb-temp/`: scratch space for a thumbnail or channel avatar while it is being fetched.

A fourth, `thumb-display/`, holds something different from scratch data: a **display-sized copy** of
each thumbnail the grid has drawn (`services/thumbnail/display.rs`), named
`<sha256-of-the-stored-thumbnail>-w<width>.jpg`. The width is in the name so that changing
`DISPLAY_THUMBNAIL_MAX_WIDTH` invalidates the cache. Nothing revalidates a cached file's dimensions,
so a name without it would keep serving the old size indefinitely. A stored thumbnail keeps whatever
size it arrived at (a
yt-dlp `maxresdefault` is 1280x720), and a webview decodes an image at its natural size regardless
of how well the file is compressed, so drawing one into a card a few hundred pixels wide costs the
full bitmap. These copies are capped at `DISPLAY_THUMBNAIL_MAX_WIDTH` (640) so the card decodes a
quarter of that.

Nothing in the database refers to them. `videos.thumbnail_path` and `channels.avatar_path` still
point at the canonical file in the library; a derivative is addressed *by* that file's own content
hash, which is already in its name, so the mapping needs no storage. That is also why the cache is
safe to delete at any time, because a missing entry is regenerated the next time the grid asks, and a
thumbnail that has been in the library for years gets one the first time it is drawn. If FFmpeg is
not available, or the source has moved, the grid simply draws the stored file as it always did.

Being derived rather than scratch is also why this one is **not** swept by age like the three above.
Regenerating a derivative costs an FFmpeg process, and a cache *hit* is a `stat` that renews nothing,
so an age rule discarded the thumbnails the grid draws every day at the same rate as the ones nothing
had looked at since they were written. Emptying the whole cache every seven days and paying it back
as a burst of FFmpeg runs on the next scroll. It is bounded by total size instead
(`DISPLAY_CACHE_MAX_BYTES` in `services/thumbnail/display.rs`). A cache that fits is left entirely
alone whatever its age, and one that does not is trimmed oldest-first until it fits.

`child-cwd/` is an empty folder made at startup (`utils::process::init_private_child_working_dir`)
for the yt-dlp and FFmpeg runs that have no directory of their own (the format listing, the
comment fetch, the version checks) to start in. It holds nothing. It exists so those runs do not
start in the shared temp directory, where any program can leave an executable that a lookup by
bare name would find.

A fifth, `pending-media/`, is created by `services/pending_media.rs` rather than
`temp_paths.rs`, and holds something different again, one `pending-*.json`
marker per media creation that has already written its artifacts into the library but has
not yet inserted the row. Adding media is not a single call, and between those two steps
the files exist with nothing pointing at them, so the marker names them. It is removed as
soon as the row lands (or the failure path has cleaned the artifacts up), which means a
marker left over from an *earlier* run is a creation the process did not survive.

`lib.rs`'s `spawn_pending_media_sweep` reconciles those shortly after launch by handing the
paths to the same reference counting the deletions use, so an artifact a registered row still
points at is kept, and a genuine orphan is moved to the library's `.trash` folder rather than
deleted (a finished download may be of something no longer on YouTube). A yt-dlp download records
a marker for its file the moment it is placed, before the live chat and the thumbnail, and the
registration replaces it with its own. Finding a
`pending-media/` marker on a healthy install means a media import died midway; the sweep
handles it on the next launch and nothing needs to be deleted by hand.

The sweep runs on a short delay rather than inline with startup, so "still present" is not by
itself enough to act on. A marker written by a creation the user started *after* launch is
also present, and its row has legitimately not been inserted yet. Consuming it would unlink
the file being added right now. So the sweep only considers a marker that is neither
registered as in flight by this process nor newer than the process itself
(`pending_media::marker_is_sweepable`), and every uncertain case is left in place, one launch
later is a cheaper mistake than deleting a file the user still wants.

A marker whose reconciliation *fails* is kept for the next launch to retry, since the usual cause is
transient (the library drive not mounted yet). A failure is either the cleanup returning an error or
any of the marker's paths that could not be moved to the trash, and a library folder that does not
exist right now counts as the second for every path, not as files already gone. Nothing there can tell transient from permanent, so
the marker carries an `attempts` count and is abandoned after `MAX_MARKER_SWEEP_ATTEMPTS` (5). A
failure that survives five launches is not a slow drive. Abandoning it means the *record* is given
up on, never the files. The marker stays on disk and its artifacts stay in the library, where the
Diagnostics dialog reports them as unreferenced. The difference is that the failure is logged once,
at error level with its count, instead of at warning level on every launch forever.

Two things have to happen together for that to be true, and they are in different functions. The
incremented count is written back to the marker on *every* failure, including the one that reaches
the ceiling; and `read_pending_markers` drops a marker whose count is already at the ceiling before
the sweep ever sees it. With only the first, an abandoned marker sits at five and is re-read on
every launch. With only the second, it sits at four and never reaches five. Either way the sweep
would retry the same failing cleanup and re-emit the notice below on every launch, which is worse
than the unbounded warning line the ceiling replaced, because that one at least stayed in the log.

Giving up is surfaced to the user once, as a notice pointing at Diagnostics
(`EVENT_PENDING_MEDIA_ABANDONED`, one event per sweep however many markers it covered), rather than
being left to the log file alone.

On startup, `lib.rs`'s `setup()` authorizes `thumbs-temp/` and `thumb-display/` (and only those
two), in the Tauri asset-protocol scope (`commands/security.rs::register_cache_asset_scope`, see
`THREAT-MODEL.md`), so a thumbnail preview can be shown in the webview via `convertFileSrc` before it is
persisted and a display derivative can be drawn by the grid. The cache **root** is deliberately not
granted, because on Windows it is the parent of the `logs` directory described below and of the WebView2
profile (`EBWebView/`), and the other three subdirectories here are read by the backend alone. A
background task
(`services::temp_cleanup::cleanup_stale_temp_files_sync`, spawned from `lib.rs`) sweeps the cache
directory on every startup, and the rule it applies depends on what a directory holds:

- The three scratch directories (`thumbs-temp/`, `yt-dlp-temp/`, `yt-dlp-thumb-temp/`) lose any
  entry older than 7 days (`TEMP_ENTRY_MAX_AGE_HOURS = 24 * 7` in `services/temp_cleanup.rs`), so an
  interrupted download/thumbnail generation does not leak disk space indefinitely.
- `thumb-display/` is bounded by total size instead, for the reason given above.
- `pending-media/` is swept by neither. Its markers are reconciled by
  `spawn_pending_media_sweep`, which decides per marker (see `marker_is_sweepable`) rather than
  by age, and a marker it cannot reconcile is deliberately kept.

So this one directory has no bound at all, and that is worth stating rather than leaving to be
noticed. An abandoned marker is never removed by anything. The growth is accepted rather than
overlooked. A marker is a couple of hundred bytes, and producing one that is never reconciled takes
a media creation that crashed *and* five consecutive launches that could not clean up after it, so
the directory grows at a rate no user will measure. Against that, a sweep able to delete these files
would be a sweep able to delete the only record of artifacts sitting in the library, which is
precisely the decision `marker_is_sweepable` refuses to make whenever it is uncertain. Diagnostics
reports what an abandoned marker names as orphans, and its **Remove orphan files** action moves the
media files and thumbnails among them to the library's `.trash` folder
(`library::cleanup::remove_orphan_artifacts`, which refuses while a media is being added). The
marker itself is safe to delete by hand once nothing references its files.

## App local data directory. Recovered downloads

`app.path().app_local_data_dir()` holds one folder, `recovered-downloads/`
(`services/kept_files.rs`):

- Windows: `%LOCALAPPDATA%\com.kavynex.app\recovered-downloads` (the same folder as the cache root
  on Windows, so do not delete the cache folder whole there)
- macOS: `~/Library/Application Support/com.kavynex.app/recovered-downloads`
- Linux: `~/.local/share/com.kavynex.app/recovered-downloads`

A download that finished but could not be moved into the library (its drive was not connected, the
disk was full) is kept here under the name yt-dlp gave it, and nothing ever deletes it, since it may
be the only copy left of a video gone from YouTube. Diagnostics reports how many files it holds and
opens the folder. Import a file from there as a local file, or delete it once it is not needed.
It is not in the cache directory because the cache is what this document and `PRIVACY.md` call safe
to delete, and what OS cleaners empty. It is not in the roaming config directory because a video is
far too large for a roaming profile to carry.

## App log directory (`kavynex.log`)

`app.path().app_log_dir()` is where `services/logger.rs` writes:

- Windows: `%LOCALAPPDATA%\com.kavynex.app\logs`
- macOS: `~/Library/Logs/com.kavynex.app`
- Linux: `~/.local/share/com.kavynex.app/logs` (under `app_data_dir`, or `$XDG_DATA_HOME`)

The logger writes to stderr always, and additionally appends to `kavynex.log` in that
directory once `services::logger::init()` has been called from `lib.rs`'s `setup()`. Log
lines are `[<RFC 3339 UTC timestamp>] [<LEVEL>] [<scope>] <message>` (for example
`[2026-07-06T12:34:56Z] [INFO] [app] application setup finished`). When the file passes 5 MB
(`MAX_LOG_BYTES`), it is rotated. The existing file becomes `kavynex.log.1` (replacing any
previous rotation) and a fresh `kavynex.log` is started, so at most two generations are
ever kept.

## The library directory

The library directory is user-chosen (persisted as `library_path` in `app_settings`; see
`docs/DATABASE.md`). There is no default, so a fresh install has no library until one is picked, and
the Home page shows a card saying so (with the same folder picker Settings > Library folder opens)
until it is. Adding media or an avatar before that is refused with a message saying so. Unlike the
app-owned directories above, the user can point this anywhere, and `services/library/migration.rs`
supports moving its contents when the path changes.

The library directory itself is never created by a write. A download, an import or a thumbnail
whose library folder is gone (a drive that is not mounted, a folder moved away) is refused instead,
since recreating it would put new media in an empty folder while every existing row names files
that are somewhere else. Only a library migration creates its destination. The subfolders below
are created only inside a library folder that is there (`library::paths::create_dir_in_existing_library`),
including by the asset-scope registration at startup and the one-time live chat move.

Inside the library directory, media services create these subfolders on demand:

- `video/`: imported/downloaded video files.
- `audio/`: imported/downloaded audio-only files.
- `thumbnails/`: persisted thumbnail images.
- `live_chat/`: gzip-compressed live chat replay JSON (`.json.gz`), one file per video
  that has live chat backed up.
- `.trash/`: what Diagnostics' **Remove orphan files** moved aside, one `<UTC time>-<suffix>/`
  folder per run that keeps each file's library-relative path (`video/media_<sha256>.mp4`, say).
  The startup sweep (`temp_cleanup::cleanup_library_leftovers_sync`) deletes a run folder once it
  is 30 days old (`ORPHAN_GRACE_PERIOD`). To bring a file back, move it to the same path under the
  library folder. A file already in the library under that name is the same bytes. Diagnostics
  reports what the trash holds and opens it, since a folder whose name starts with a dot is hidden
  by default on macOS and Linux. A library move carries the trash along with the media folders.

  The removal takes only `media_<sha256>`/`thumb_<sha256>` files no row names, never one written in
  the last hour (a thumbnail or avatar lands a call before its row), and is refused for 30 days after
  a database import or restore, or while most of those files are unreferenced. Both are what an
  older database, or another library's, looks like, and moving its files aside would leave the
  import's undo pointing at nothing.

### Filenames

Two different naming schemes are used, depending on how a file enters the library.

**Content-addressed (local imports and thumbnails).** These files are named after the
SHA-256 hash of their own content (`utils/hash.rs::file_hash`, computed by streaming the
file rather than loading it whole):

- `video/media_<sha256>.<ext>` or `audio/media_<sha256>.<ext>`: a **locally imported**
  file, written by `services/library/media.rs::stage_media_import_cancellable_sync`.
- `thumbnails/thumb_<sha256>.<ext>`: written by `services/thumbnail/persist.rs`.

This makes storage naturally deduplicated (two imports of byte-identical content produce
the same filename) and content-verifiable (the filename itself is a checksum). It also
means renaming or re-encoding a file outside the app changes its hash and therefore its
expected filename. The deep check in Diagnostics (`services/library/verification.rs`) re-reads
each file and compares it against that name. The cheaper check that runs whenever Diagnostics
opens (`services/library/integrity.rs`) only compares the database with what is on disk.

**yt-dlp downloads are content-addressed too.** yt-dlp writes into the run's temp directory under
its own name (`youtube_<id>_<format_id>.<ext>`), and `place_downloaded_file` in
`services/yt_dlp/download/placement.rs` hashes the finished file and stores it as
`media_<sha256>.<ext>`, the same name a local import of those bytes would get
(`library::media::content_addressed_media_name`). A file already at that name whose bytes still
hash to it is the same content (the same video saved for another channel), so it is reused and the
fresh download discarded. One whose bytes do not is a damaged copy, and the fresh download
replaces it.

Downloads saved by Kavynex 1.7.0 and earlier kept yt-dlp's name, `youtube_<id>_<format_id>.<ext>`.
They still work, and the deep check reports them as unverifiable because their name declares no
hash.

Live chat files are likewise named from the video/run rather than content-hashed (they are
written once by a yt-dlp run and not re-derived); see `services/yt_dlp/download/post_download.rs` and
`services/live_chat_storage.rs` for the exact naming if you need to trace a specific file.

All paths stored in the database (`videos.file_path`, `videos.thumbnail_path`,
`videos.live_chat_file_path`, `channels.avatar_path`) are relative to the library
directory, never absolute, so the library can be moved or the app data relocated without
invalidating every row. `utils/path.rs` is what enforces that any relative path used this
way stays inside the library directory (see `THREAT-MODEL.md`).
