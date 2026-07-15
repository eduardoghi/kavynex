# Database

Kavynex stores its structured data in a single SQLite database file, `kavynex.db`, opened
through `sqlx`. Everything schema-related lives in `src-tauri/src/services/db_schema.rs`;
everything about the connection (WAL, timeouts, foreign keys) lives in
`src-tauri/src/services/database.rs`; backup/restore/export/import lives in
`src-tauri/src/services/db_backup.rs`. See `docs/DIRECTORIES.md` for exactly where the
database file and its backups live on disk.

## Schema

Four tables, created by `db_schema.rs`:

### `channels`

```sql
CREATE TABLE channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (TRIM(name) <> ''),
    youtube_handle TEXT NOT NULL UNIQUE CHECK (TRIM(youtube_handle) <> ''),
    avatar_path TEXT CHECK (avatar_path IS NULL OR TRIM(avatar_path) <> ''),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

One row per followed YouTube channel (or a channel created for locally-imported media).
`youtube_handle` is unique; `avatar_path` is a path relative to the library directory.

### `videos`

```sql
CREATE TABLE videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    title TEXT NOT NULL CHECK (TRIM(title) <> ''),
    file_path TEXT NOT NULL CHECK (TRIM(file_path) <> ''),
    thumbnail_path TEXT CHECK (thumbnail_path IS NULL OR TRIM(thumbnail_path) <> ''),
    media_type TEXT NOT NULL CHECK (media_type IN ('video', 'audio')),
    youtube_video_id TEXT,
    watched_at TEXT,
    published_at TEXT,
    duration_seconds INTEGER,
    progress_seconds INTEGER NOT NULL DEFAULT 0,
    has_comments INTEGER NOT NULL DEFAULT 0,
    comments_count INTEGER NOT NULL DEFAULT 0,
    is_live INTEGER NOT NULL DEFAULT 0,
    has_live_chat INTEGER NOT NULL DEFAULT 0,
    live_chat_file_path TEXT CHECK (live_chat_file_path IS NULL OR TRIM(live_chat_file_path) <> ''),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    UNIQUE (channel_id, file_path)
)
```

One row per media item (video or audio), local or downloaded. Note what is *not* here:
there is no column holding live chat messages themselves - `live_chat_file_path` only
points at a file on disk (see "Live chat is not in the database" below). `file_path` and
`thumbnail_path` are stored relative to the library directory, matching `avatar_path`.
Uniqueness is enforced two ways: `(channel_id, file_path)` always, and, via a partial
unique index, `(channel_id, youtube_video_id)` whenever `youtube_video_id` is set - so the
same YouTube video can't be added twice to a channel, but multiple purely-local imports
with no YouTube id don't collide with each other.

### `video_comments`

```sql
CREATE TABLE video_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    comment_id TEXT,
    parent_comment_id TEXT,
    author_name TEXT NOT NULL,
    author_handle TEXT,
    author_channel_id TEXT,
    author_thumbnail TEXT,
    text TEXT NOT NULL,
    like_count INTEGER NOT NULL DEFAULT 0,
    reply_count INTEGER NOT NULL DEFAULT 0,
    is_author_uploader INTEGER NOT NULL DEFAULT 0,
    is_favorited INTEGER NOT NULL DEFAULT 0,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_edited INTEGER NOT NULL DEFAULT 0,
    time_text TEXT,
    published_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
)
```

Comments fetched from YouTube via yt-dlp for a given video, flattened with
`parent_comment_id` for building the reply tree in the frontend.

### `app_settings`

```sql
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

A generic key/value table, upserted via `INSERT ... ON CONFLICT(key) DO UPDATE`. The keys it
holds are whatever `StoredAppSettings` in `database.rs` defines - currently `import_mode`,
`library_path`, `load_remote_images` and `check_updates_on_startup`. Read them from there
rather than trusting a count here: adding a setting is a one-line change on that struct, and
this document is not what stops the two from drifting.

### Live chat is not in the database

Live chat replay data is stored as gzip-compressed JSON files on disk under the library's
`live_chat/` directory (see `docs/DIRECTORIES.md`), never as rows in SQLite. The `videos`
table only carries a `has_live_chat` flag and a `live_chat_file_path` pointing at that
file. A `video_live_chat_messages` table existed in older versions of the app but was
always empty by design; it is dropped by the baseline migration
(`LEGACY_TABLE_DROPS` in `db_schema.rs`) if found on an existing database.

### Foreign keys and cascades

`videos.channel_id` and `video_comments.video_id` both declare
`FOREIGN KEY (...) REFERENCES ... ON DELETE CASCADE`, and every connection opens with
`PRAGMA foreign_keys = ON` (see "Connection settings" below). Deleting a channel deletes
its videos, which in turn deletes their comments, in the database itself - the artifact
cleanup code (`services/library_cleanup.rs`) is only responsible for the *files* that
belonged to those rows (media, thumbnails, avatar, live chat), not for the rows.

### Indexes

`db_schema.rs` creates a set of indexes to support the app's real query patterns:
`videos(channel_id)`, a composite `videos(channel_id, created_at DESC, id DESC)` for the
"list a channel's media, newest first" query, lookups by `youtube_handle`,
`avatar_path`, `thumbnail_path`, `youtube_video_id`, `watched_at`, `published_at`,
`has_comments`, `is_live`, `has_live_chat`, a unique index backing
`(channel_id, file_path)`, a partial unique index backing
`(channel_id, youtube_video_id)`, single-column indexes on `file_path` and
`live_chat_file_path` (which keep the per-artifact reference-count lookups run on every
media/channel delete off a full table scan - the composite `(channel_id, file_path)`
index cannot serve a bare `file_path =` predicate), and comment lookups by `video_id`,
`parent_comment_id`, and `comment_id`. All index DDL uses
`CREATE INDEX IF NOT EXISTS`, so it is safe to re-run on every migration.

## Versioned migrations

The schema version is tracked with SQLite's built-in `PRAGMA user_version`, compared
against a Rust constant, `SCHEMA_VERSION` (currently `11`), in `db_schema.rs`.
`ensure_schema(pool)` runs once, synchronously, as part of opening the shared connection
pool (`database.rs::build_pool_at`), before any other query executes.

- **Baseline (versions 0..=6 -> 7).** Every database that predates versioned migrations -
  including a brand-new, empty database - is below `BASELINE_SCHEMA_VERSION` (7) and goes
  through `apply_baseline_schema` exactly once: it drops the legacy
  `video_live_chat_messages` table, creates all four tables with `CREATE TABLE IF NOT
  EXISTS`, adds any missing additive `videos` columns (`is_live`, `has_live_chat`,
  `live_chat_file_path`, `title_normalized`) with guarded `ALTER TABLE ... ADD COLUMN`,
  creates every index,
  then stamps `user_version = 7`. Because every statement is idempotent
  (`IF NOT EXISTS` / column-existence-checked `ALTER`), running the baseline against an
  already-current database is a no-op.
- **v8** adds the `idx_videos_channel_created_id` index. Being purely additive, its
  migration just re-runs the index DDL list and stamps `user_version = 8`.
- **v9** adds the `idx_videos_file_path` and `idx_videos_live_chat_file_path` indexes,
  which keep the per-artifact reference-count lookups run on delete off a full table scan.
  Also purely additive, so its migration re-runs the index DDL list and stamps
  `user_version = 9`.
- **v10** adds the partial unique index `idx_video_comments_video_comment_unique` on
  `video_comments(video_id, comment_id)` (where `comment_id` is non-null and non-blank),
  moving the "no duplicate `(video_id, comment_id)`" invariant out of application code
  (`media_comments::dedupe_comments_by_id`) and into the schema. Unlike v8/v9 it cannot
  blindly create the index: a pre-v10 database could already hold a duplicate the unique
  build would reject, so the migration first collapses any duplicate comment rows to the
  lowest `id` (backed by a temporary `(video_id, comment_id, id)` index it drops again) and
  only then creates the real index, all in one transaction before stamping
  `user_version = 10`.
- **v11** adds the `title_normalized` column (an accent/case-folded copy of `title`) and its
  `idx_videos_channel_title_normalized` index, and backfills the column for every existing row.
  Unlike v8/v9 it is not index-only: SQLite cannot accent-fold in SQL, so the backfill is
  computed in Rust with the same `utils::text::normalize_search_text` used at insert/update time
  (that shared normalization is what keeps a stored title and a search term comparable). The
  column-add, the per-row backfill and the index creation all run in one transaction that stamps
  `user_version = 11`.
- **Additive vs. table-rebuild migrations.** A new column or index is additive: guard it
  with a column-existence check (like `ensure_videos_additive_columns`) or
  `CREATE INDEX IF NOT EXISTS`, wrap it in a migration function, and bump
  `SCHEMA_VERSION`. A change `ALTER TABLE ADD COLUMN` cannot express - a new/changed
  `CHECK`, a new `UNIQUE`, a changed column type, or dropping a column - instead uses the
  table-rebuild path: `TableRebuild` + `rebuild_table` + `apply_table_rebuilds` follow
  SQLite's documented procedure (create the new shape under a staging name, copy the
  carried columns across, drop the old table, rename the staging table into place), with
  foreign keys disabled for the duration (otherwise `DROP TABLE` on a parent would cascade
  and wipe out its children) and a `PRAGMA foreign_key_check` before committing to catch
  any dangling reference the rebuild introduced. This path is implemented and tested but
  unused as of `SCHEMA_VERSION 11` - no migration has needed it yet - kept ready so the
  first real rebuild is a data change, not new untested plumbing.
- **Transactional and idempotent.** Every migration function runs inside its own
  transaction that also stamps the new `user_version`, so a crash mid-migration leaves the
  database fully at the previous version or fully at the next one, never half-migrated.
  Re-running `ensure_schema` against an up-to-date database does nothing.
- **Refusing a newer schema.** If the on-disk `user_version` is higher than the
  `SCHEMA_VERSION` this build knows about, `ensure_schema` returns an error instead of
  touching anything - an older build can never silently downgrade or corrupt a database
  produced by a newer one. The same check exists on the import path
  (`validate_import_source` in `db_backup.rs`) so importing a database from a newer
  Kavynex version is rejected up front.

## Connection settings

Every pooled connection (`database.rs::build_pool_at`) is configured identically via
`SqliteConnectOptions`:

- `journal_mode(Wal)` - write-ahead logging, so readers are never blocked by a writer.
- `synchronous(Normal)` - durable across an app crash; only the last few transactions are
  at risk on an OS crash or power loss. This is the standard desktop-app tradeoff against
  the slower default `FULL` (fsync on every commit).
- `busy_timeout(30_000ms)` - a connection waits up to 30 seconds for a lock instead of
  failing immediately with `SQLITE_BUSY` when another connection (or the backup/export
  path, which opens its own short-lived pool against the same file) holds it.
- `foreign_keys(true)` - `ON DELETE CASCADE` is only enforced when this pragma is on, and
  it must be set per-connection (it does not persist in the database file itself).

The pool itself (`SqlitePoolOptions`) caps at 4 connections. It is held in Tauri-managed state
as a `Db` handle (`app.manage(Db::new(path))` in `lib.rs`, keyed to the database path resolved at
startup) rather than a free-standing global; the `SqlitePool` lives in a `tokio::sync::OnceCell`
*inside* that handle, opened lazily on first use (`Db::pool`) and reused for the app's lifetime.
It cannot be closed and reopened in-process, which is why the restore/import flows below stage
their changes for the *next* startup instead of swapping the live pool. Keeping it in managed
state (rather than a process-wide static) also lets tests inject an in-memory pool via
`Db::from_pool`.

## Backup, restore, export, import

All four operations are implemented in `db_backup.rs`.

### Automatic backup (`backup_database`)

A best-effort snapshot taken via `VACUUM INTO` into a sibling `.bak` file, throttled to at
most once every 24 hours (checked by the `.bak` file's mtime). It runs:

- **Synchronously, before the pool opens**, when a schema migration is about to run
  (`is_schema_migration_pending` - true when the database file is missing, or its
  `user_version` is below the build's `SCHEMA_VERSION`) - so a bad migration or
  pre-existing corruption can be rolled back.
- **In the background**, off the startup critical path, on a normal launch where no
  migration is pending.

Before snapshotting, the source database must pass `PRAGMA quick_check` (`is_healthy`); a
database that fails it is skipped so a corrupt database is never allowed to overwrite a
good backup. Rotation keeps several generations: before the fresh snapshot is written, the
existing generations are shifted up by one (`.bak` -> `.bak.1`, `.bak.1` -> `.bak.2`, and so on),
dropping the oldest. `BACKUP_ROTATED_GENERATIONS` (6) rotated files are kept in addition to the
current `.bak`, so up to seven snapshots can exist (`.bak` plus `.bak.1`..`.bak.6`) - keeping more
than one guards against the case where the newest snapshot itself captured an already-degrading
database before the corruption was caught. A `.bak.tmp` is used during the `VACUUM INTO` and only
renamed into `.bak` after it succeeds. Because `VACUUM INTO` requires the destination not to
already exist, and produces a single, fully checkpointed file, `.bak` is always a complete,
WAL-free snapshot - never combined with a live write-ahead log.

### Restore (`restore_database_from_backup`)

Used when opening the live database fails. It tries `.bak` first, then `.bak.1`, picking
the first candidate that itself passes `quick_check`; if neither is healthy, it fails with
`NoDatabaseBackupAvailable`. The current (assumed corrupt) database is moved aside to a
sibling `.corrupt` file - never deleted - so it can still be inspected, and its `-wal`/
`-shm` sidecars are removed so the restored snapshot is never combined with a stale
write-ahead log. A repeated restore rotates the earlier snapshots (`.corrupt` becomes
`.corrupt.1`, and so on) rather than overwriting them, so the first failure's evidence
survives the second - which is when it is most worth having. Fewer generations are kept
than for `.bak`: each one is a full copy of an already-broken database, so the oldest is
dropped once the rotation is full. The chosen backup is copied to a `.restore.tmp` staging file first and
only renamed into place after the corrupt database has been moved aside, so a failure
partway through never leaves the app without a database file. The caller must ensure the
connection pool is not already open before calling this (it is only reachable from the
restore-from-backup UI flow, which by definition follows a failed open).

### Export (`export_database`)

A user-triggered `VACUUM INTO` snapshot to a user-chosen destination path (via a save
dialog). Refuses to export a database that fails `quick_check`. The destination is
cleared first (`VACUUM INTO` fails if the target already exists).

### Import (`stage_database_import` / `apply_pending_database_import`)

Importing a user-selected `.db` file is a two-step, startup-deferred process, because the
live connection pool is a singleton that cannot be reopened mid-session:

1. `stage_database_import` validates the selected file - it must open as a healthy SQLite
   database (`quick_check`), contain the four core tables (`channels`, `videos`,
   `video_comments`, `app_settings` - a cheap "is this actually a kavynex database" check),
   and have a `user_version` no higher than this build's `SCHEMA_VERSION`
   (`DatabaseSchemaTooNew` otherwise) - then copies it to a `.import-staged.tmp` file and
   renames it to `.import-staged` (atomic staging, so a partial copy is never picked up).
2. On the *next* app startup, before the pool opens, `lib.rs`'s `setup()` calls
   `apply_pending_database_import`. If a staged file exists, the current database is
   moved aside to `.pre-import` (a safety net, not deleted), the staged file's `-wal`/
   `-shm` sidecars are dropped, and the staged file is renamed into place as the new
   `kavynex.db`. If that rename fails, the previous database is rolled back from
   `.pre-import` so the app is never left without one to open. A failure here is logged
   but never blocks startup.

## Related files

- `src-tauri/src/services/db_schema.rs` - schema DDL, migrations, `SCHEMA_VERSION`.
- `src-tauri/src/services/database.rs` - pool creation, connection options, app settings
  key/value helpers.
- `src-tauri/src/services/db_backup.rs` - backup, restore, export, import.
- `src-tauri/src/commands/database.rs` - the Tauri commands exposing these operations.
- `src/services/database-service.ts` - the frontend service calling those commands.
