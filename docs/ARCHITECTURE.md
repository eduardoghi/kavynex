# Architecture

Kavynex is a Tauri v2 desktop app: a Rust backend (`src-tauri/`) that owns the database,
the filesystem, and every external process (yt-dlp, FFmpeg), and a React 19 + TypeScript
frontend (`src/`) that renders the UI and never touches the filesystem or the database
directly. The two sides talk over Tauri's IPC (`invoke`/`emit`), never anything else.

## Backend layering

```
tauri::command (src-tauri/src/commands/*.rs)
        |
        v
service / repository (src-tauri/src/services/*.rs)
        |
        v
utils (src-tauri/src/utils/*.rs): path safety, process spawning, hashing, io
        |
        v
sqlx (SQLite) / std::fs / std::process (yt-dlp, ffmpeg)
```

- **Commands** (`src-tauri/src/commands/`) are the only `#[tauri::command]` functions,
  one module per feature area (`channels.rs`, `videos.rs`, `media.rs`, `thumbnail.rs`,
  `live_chat.rs`, `yt_dlp.rs`, `database.rs`, `security.rs`, `settings.rs`, `comments.rs`,
  `library.rs`, `logging.rs`, `webview_check.rs`). A command's job is to take the request from IPC, open the
  shared database pool or resolve an app path, and delegate to a service. It holds
  essentially no logic of its own. Example (`commands/channels.rs`):

    ```rust
    #[tauri::command]
    pub async fn list_channels(app: AppHandle) -> AppResult<Vec<ChannelRow>> {
        let pool = shared_pool(&app).await?;
        repo::list_channels(pool).await
    }
    ```

- **Services** (`src-tauri/src/services/`) hold the actual logic, split by concern rather
  than by a strict service/repository naming split. Some files are "repositories" in
  spirit (`channel_repository.rs`, `video_repository/` hold the SQL), others are
  domain services. All schema/query code lives here, never in `commands/`.

  Two rules decide whether a concern is a file or a directory, and they apply at different
  scales:

  - **A file that outgrew itself becomes a directory of the same name**, with the coupled
    core in `mod.rs` and the separable part split off: `db_schema/` (`ddl.rs`,
    `migrations.rs`, `introspection.rs`, `rebuild.rs`), `db_backup/` (`snapshot.rs`,
    `restore.rs`, `integrity.rs`,
    `external.rs`, `import.rs`), `video_repository/` (`media_page.rs`) and
    `yt_dlp/download/` (`command.rs`, `redaction.rs`).
  - **A feature family that outgrew a shared filename prefix becomes a directory too.**
    `library_*`, `thumbnail_*` and `yt_dlp_*` were nine, six and seven flat siblings whose
    common prefix was already naming a directory, so they are now `library/`
    (`cleanup.rs`, `guard.rs`, `integrity.rs`, `lock.rs`, `media.rs`, `migration.rs`,
    `paths.rs`, `recovery.rs`, `summary.rs`), `thumbnail/` (`display.rs`, `download.rs`,
    `persist.rs`, `picked.rs`, `redirect.rs`, `temp.rs`, `url.rs`) and `yt_dlp/`
    (`cookies.rs`, `events.rs`, `metadata.rs`, `registry.rs`, `url.rs`, plus the nested
    `download/`). Each family's `mod.rs` declares its submodules and re-exports the entry
    points the command layer imports, so a caller does not have to know which submodule
    holds each one.

  Within a family, siblings reach each other through `super::` (matching `db_schema/`,
  `db_backup/` and `video_repository/`); everything outside it uses the full path, so a
  call site reads `library::cleanup::delete_media_with_artifacts` rather than a bare
  `cleanup::` that says nothing about which tree it belongs to.

  That rule used to carry a second job, and it is worth recording that it no longer does. The flat
  sweep of the disposable cache directories was called `services::cleanup`, so a bare `cleanup::`
  was not merely vague but *ambiguous*. It could have meant either that module or
  `library::cleanup`, which reference-counts and unlinks the user's media. The import convention
  was what kept them apart, which made two unrelated concerns distinguishable only by how a call
  site chose to spell them. It is `services::temp_cleanup` now, so the names carry the distinction
  and the convention above is back to being about readability alone.

  What stays a flat file is a concern with no family: `database.rs`, `binaries.rs`,
  `temp_cleanup.rs`, `logger.rs`, `file_manager.rs`, `filesystem.rs`, `live_chat_storage.rs`,
  `media_comments.rs`, `media_creation.rs`, `pending_media.rs`, `process_registry.rs`,
  `ssrf_guard.rs`, `temp_paths.rs`, `channel_repository.rs`.

  `file_manager.rs` is the one of those that arrived by moving rather than by being written, and the
  move is the rule above read backwards. It lived inside `library/` while the "reveal a media file"
  flow was its only caller, which made it look like a library concern. Resolving
  `explorer.exe`/`open`/`xdg-open` and spawning it is not one. A second caller (the Diagnostics
  "Open log folder" button, `commands/logging.rs`) made the mis-homing cost something real: leaving
  it there meant either a cross-family import or a second copy of the three per-platform spawn
  branches. What stayed behind in `library/` is the part that *is* a library concern, the
  containment check. See `docs/THREAT-MODEL.md` for why that split is the security-relevant half.
- **Utils** (`src-tauri/src/utils/`) are small, pure, dependency-free helpers reused
  across services:
  - `path.rs`: the path-safety primitives (sanitizing a relative path, canonicalizing and
    containment-checking a path against a base directory). See `docs/DATABASE.md` and
    `THREAT-MODEL.md` for how this backs the library/asset-scope guarantees.
  - `process.rs`: everything about spawning an external child: suppressing the flashing
    console window Windows would otherwise show from a windowed app (`hide_console`), putting
    the child in its own process group, and killing a whole process tree
    (`kill_process_tree`). The last two are a pair. The Unix kill signals the negated pid,
    i.e. the group, so a child spawned without its own group is not reachable by the kill that
    every timeout path depends on.
  - `hash.rs`: SHA-256 file hashing used for the content-addressed media/thumbnail
    filenames (see `docs/DIRECTORIES.md`).
  - `naming.rs`: `unique_temp_suffix()` (pid + nanoseconds + a monotonic counter), and the
    **only** place in the tree allowed to derive a name from a raw timestamp. Every temporary
    path, in production and in tests, is built from it, because pid + nanoseconds alone
    collides when two callers land in the same clock tick, which was a real intermittent
    failure, on macOS, surfacing nowhere near its cause. `ci.yml`'s "Verify temp paths are
    built from the shared unique suffix" step enforces this, since the convention had already
    drifted back twice.
  - `validation.rs`: the channel name/handle and media title/type validators every write
    boundary calls, including the control-character and length rules. Under the mutation gate
    (`src-tauri/.cargo/mutants.toml`), and its handle *shape* rule is asserted against
    `shared/youtube-handle-cases.json` so it cannot drift from the frontend's copy. Note the split
    that follows from that: the shape lives in `is_valid_youtube_handle`, which the shared fixture
    pins, while the control-character and length rules sit beside it in
    `ensure_valid_youtube_handle`, matching how the name and title validators are already built.
    They are not part of the shared contract because they are not part of the shape, and folding
    them in would mean changing the frontend to keep the fixture honest.
  - `text.rs`: accent stripping, whitespace collapsing and `LIKE`-metacharacter escaping,
    behind the normalized columns the media search queries against.
  - `format.rs`: the allowed media/thumbnail extension lists (and their user-facing labels),
    the extension-to-subdirectory mapping, and `format_bytes`, shared by the library and
    database size summaries.
  - `bounded_semaphore.rs`: the permit-based limiter bounding how much parallel work runs at
    once.
  - `task.rs`, `io.rs`: a `run_blocking` wrapper for moving blocking work off the async
    runtime, and line readers that cap how much a single unbounded line from a child process
    can buffer.
- Below that, services call `sqlx` against the shared SQLite pool (`services/database.rs`),
  `std::fs` for the filesystem, and `std::process::Command` / `tokio::process::Command` to
  run yt-dlp and FFmpeg (resolved via `services/binaries.rs`).

`src-tauri/src/lib.rs` wires all of this together: it registers the plugins (below), registers
every command in `invoke_handler(tauri::generate_handler![...])`, and in `setup()` initializes the
file logger, applies any staged database import before the connection pool opens, authorizes
the cache directory in the asset-protocol scope, and spawns a background cleanup of stale
temp files. On `ExitRequested` it cancels any in-flight yt-dlp/FFmpeg downloads so they are
not left running as orphans.

### The plugin chain, and why its order matters once

Six plugins are registered, and the order of the list is not arbitrary at its head.
`tauri-plugin-single-instance` **must be first**. A second launch is redirected into the running
process's callback (which focuses the existing window) instead of starting a second instance, and a
second instance would open a second `SqlitePool` onto the same database file and a second
per-process download registry, which is a data-integrity problem rather than a cosmetic one.
Registering it after a plugin that can fail or block would leave that window open. The invariant is
stated here as well as in the code comment because a plugin list reads as an unordered set.

Four of the six are the ones the frontend actually calls, and each has a matching grant in
`src-tauri/capabilities/`: `tauri-plugin-process` (relaunch after an update),
`tauri-plugin-updater`, `tauri-plugin-opener` (YouTube links) and `tauri-plugin-dialog` (the file
and folder pickers). The remaining two (`tauri-plugin-single-instance` and
`tauri-plugin-window-state`, which persists the window's size and position across launches) do
their whole job from the Rust side, through a launch hook and a window-event hook. Nothing in
`src/lib/` calls either, so neither appears in `capabilities/` and neither needs to; see
`docs/THREAT-MODEL.md` for why that is the correct state rather than a missing grant, and
`docs/DIRECTORIES.md` for the file window-state writes.

### Generated TypeScript bindings (ts-rs)

Rust types that cross the IPC boundary derive `ts_rs::TS` with `#[ts(export, export_to =
"../../src/types/generated/")]` (see `StoredAppSettings` in `services/database.rs` for an
example). Running the type's generated test (the `ts-rs` macro emits a hidden `#[test]`
per exported type) writes the corresponding `.ts` file under `src/types/generated/`. CI
regenerates and diffs them so a Rust-side type change can never silently drift from what
the frontend imports:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib export_bindings
git diff --exit-code -- src/types/generated
```

(`ci.yml`, the "Verify generated TS bindings are up to date" step, run once on Ubuntu.)
Never hand-edit files under `src/types/generated/`. Change the Rust type and regenerate.

## Frontend layering

```
components (src/components/**)
        |
        v
hooks (src/hooks/**), composed by useHomeController
        |
        v
use-cases (src/use-cases/**)  <-- optional orchestration step for multi-repository flows
        |
        v
services (src/services/**)
        |
        v
repositories (src/repositories/**)
        |
        v
src/lib/tauri-client.ts  ->  @tauri-apps/api  ->  IPC  ->  Rust commands
```

(Alongside it, `src/lib/tauri-platform.ts` covers the non-IPC Tauri surfaces (dialogs, the
system opener, process relaunch, the updater, the app version, `convertFileSrc`), so those
never reach a component either. See "The Tauri boundary" below.)

- **Components** (`src/components/`) are presentation: they receive data and callbacks as
  props and render Mantine/React UI. They never call `invoke()` and never import
  `@tauri-apps` directly, only the two seam modules under `src/lib/` do.
- **Hooks** (`src/hooks/`) hold UI state and orchestration. `useHomeController`
  (`src/hooks/home/use-home-controller.tsx`) is the composition root for the main `Home` page:
  it wires together `useErrorModal`, `useAppBootstrap`, `useAppSettings`, `useChannels`,
  `useMediaLibrary`, `useDiagnostics`, and a handful of `useHome*` hooks that derive
  view/panel state and actions from those slices, then returns a single `HomeController`
  object consumed by `src/pages/Home.tsx`.

  The **same rule that decides a backend directory decides one here**, and it is worth saying so
  rather than leaving the two trees looking like they were organized by different people: a feature
  family that outgrew a shared filename prefix becomes a directory. `use-home-*` had reached ten
  siblings, `use-media-*` eight, so they are `home/` and `media/` now, and `channels/` and
  `settings/` group the two families whose members describe one concern under more than one prefix
  (`use-channels` next to `use-create-channel-form`; `use-app-settings*` next to
  `use-settings-controller`). What answers "which hooks does the Home composition actually wire?" is
  now `ls src/hooks/home`, which is what it was not while all fifty sat flat.

  What stays flat is what has no family, exactly as `database.rs` and `binaries.rs` do on the other
  side. That covers two kinds of file, and the distinction matters when deciding where a new hook
  goes. The **primitives** are hooks with no feature at all (`use-async-flag`, `use-memo-object`,
  `use-request-guard`, `use-modal-lock`, `use-per-id-async-flag`, `use-has-been-true`,
  `use-grid-scroll-restoration`), and they belong at the root permanently, since a directory would
  imply they serve one area when every area calls them. The rest are families that simply have not
  outgrown their prefix yet (`use-add-media-*` is three, `use-yt-dlp-*` two,
  `use-database-integrity-*` two). Those move when they grow, and not before. A directory per pair
  is the failure mode this rule exists to avoid, not the goal.
- **Use-cases** (`src/use-cases/`) capture a business operation that spans more than one
  repository/service call as a single named function (e.g. `create-channel.ts`,
  `delete-media.ts`, `mark-media-watched.ts`, `change-library-path.ts`,
  `initialize-app-settings.ts`). Hooks call into use-cases for these flows instead of
  inlining multi-step orchestration.
- **Services** (`src/services/`) wrap a feature area's behavior on top of one or more
  repositories/commands, e.g. `media-download-service.ts`, `thumbnail-service.ts`,
  `library-service.ts`, `live-chat-service.ts` (with the pure replay parser split into
  `live-chat-parsing.ts`, which reads JSON this app did not produce and so is kept free of IPC),
  `diagnostics-service.ts`,
  `app-update-service.ts`. Some call `invokeCommand`/`invokeVoid` directly for commands
  that are not backed by a `videos`/`channels` table row (thumbnails, yt-dlp runs,
  database backup/restore, settings).
- **Repositories** (`src/repositories/channel-repository.ts`,
  `src/repositories/media-repository.ts`) are the thin, typed layer directly over a
  database-backed Tauri command (`listChannels`, `insertChannel`,
  `deleteChannelWithArtifacts`, etc.), one function per command, no business logic.
- **`src/lib/tauri-client.ts`** is the IPC boundary: `invokeCommand`/`invokeVoid` wrap
  `@tauri-apps/api/core`'s `invoke()` (normalizing thrown errors through `parseAppError`)
  and `listenTauri` wraps `@tauri-apps/api/event`'s `listen()`. Every repository and
  IPC-calling service goes through these functions. Use `invokeCommand` when the command
  returns a value and `invokeVoid` when it does not; the command name is typed as
  `TauriCommandName`, so it must come from the `TAURI_COMMANDS` map rather than a literal.
- **`src/lib/tauri-platform.ts`** is the sibling seam for Tauri's *platform* capabilities:
  everything that is not a call into our own Rust backend: `openFileDialog`/`saveFileDialog`
  (plugin-dialog), `openUrl` (plugin-opener), `relaunch` (plugin-process),
  `checkForAppUpdate` plus the `Update` type (plugin-updater), `getVersion`, and
  `convertFileSrc`. These are deliberate re-exports rather than wrappers: each keeps the
  plugin's exact signature, so routing a caller through the seam is a pure import change.
  Error normalization stays with the IPC seam, which is where `AppError` is produced.

### The Tauri boundary

A component never calls `invoke()`; it calls a hook; the hook calls a use-case or service;
the service or repository calls `invokeCommand`/`invokeVoid` from `tauri-client.ts`. Events
emitted by the backend (yt-dlp progress, download completion) are subscribed to the same
way, through `listenTauri`.

`src/lib/tauri-client.ts` and `src/lib/tauri-platform.ts` are the **only** two files that
import `@tauri-apps` at all, and that is enforced by `eslint.config.js`'s
`no-restricted-imports` rule rather than by code review. The point is not tidiness: it keeps
"which Tauri capabilities does this app actually use?" (the question every review against
`src-tauri/capabilities/` has to answer), a two-file read instead of a tree-wide grep that
any new caller could silently invalidate. A test that needs to stub a Tauri call mocks the
seam module (`vi.mock("../lib/tauri-platform", ...)`), never the `@tauri-apps` package.

## Main flows

The layering above says where a kind of code lives; it does not say what actually happens when
a user clicks something. These three flows are the ones worth tracing before changing anything
around them: each spans several hooks, crosses the IPC boundary more than once, and has an
ordering that is load-bearing rather than incidental. Everything else in the app is a variation
on one of them.

### Adding media

Entry point: the add-media modal, driven by `useAddMediaWorkflow` (`src/hooks/`), which
`useMediaLibrary` composes. The modal has two source modes, and they diverge only in how the
artifacts are produced.

**The yt-dlp pre-step.** Pasting a URL and loading formats runs
`useYtDlpFormatLoader.loadYtDlpFormats()`, which calls `list_yt_dlp_formats`. A metadata-only
yt-dlp run, no download. It returns the available formats, a suggested title, and
`resolvedYoutubeVideoId`. That last one is why the pre-step matters beyond picking a quality:
knowing the video id *before* downloading is what lets the duplicate check below fail fast
instead of after fetching a whole file. The loader goes through `useRequestGuard`, so a slow
response for a URL the user has since changed cannot repopulate the selection that feeds the
real download command.

**The run.** `addMedia()` validates through the `validateAddMediaForm` use-case, then runs
inside `useAsyncFlag`, whose ref is set before any `await`, two synchronous invocations can
never both pass, so a double click cannot start two downloads. For a yt-dlp source it generates
the run id and opens the terminal session before calling into the service layer.

`createMedia` (`src/services/media-service.ts`) is a thin wrapper from there: it normalizes the form
through `validateCreateMediaInput` and hands the whole request to one command, `create_media`. The
ordering lives on the other side, in `services/media_creation.rs`:

1. `normalize_create_media_request`: title, media type, and every stored value trimmed. Runs first
   and entirely, so a rejected request has produced nothing to clean up.
2. yt-dlp only: `ensure_youtube_media_is_new` on the video id the format picker resolved, so a
   re-add fails before the download rather than after it.
3. `prepare_yt_dlp_artifacts` / `prepare_local_artifacts`: the download or import, plus the
   thumbnail. **The files are in the library from here on.**
4. `register_prepared_media`, under `library::cleanup::media_registration_guard`: the crash marker,
   the duplicate check on the stored path, `insert_media`, then the marker's removal. A failure
   inside it cleans the artifacts up (reference-counted, so a path a registered row shares is kept)
   while still holding the lock.

Steps 3 and 4 are in that order and not the other way round: a marker written before the artifacts
exist would name files that were never created. And the marker is cleared *after* the row lands or
the cleanup has run, never before, because until then it is the only record of what is on disk.

**Why one command.** This was seven IPC calls until the transaction moved. Two things came with the
move, and `THREAT-MODEL.md` covers both: the artifacts-without-a-row window no longer crosses the process
boundary, and the exclusion against a concurrent reference-counted cleanup is a backend lock rather
than the modal refusing to open twice. The individual steps (`import_media_file`,
`download_media_from_url`, the two crash-marker commands, ...) were removed from the IPC surface at
the same time. A command exposes an operation, not its steps.

**What stayed in the renderer**, deliberately, is everything that runs *after* the row lands: the
duration probe (`readMediaDurationInSeconds`, which needs a media element the backend does not have,
written back through `update_media_duration`), the comment backup, and the live-chat notice. None of
them can strand an artifact, because the media is already registered when they run.

**Progress and cancellation.** During step 2 the backend streams `yt-dlp-log` / `yt-dlp-error`
/ `yt-dlp-finished` / `yt-dlp-cancelled` / `yt-dlp-terminal` (`src/constants/events.ts`),
correlated by run id; `useYtDlpEvents` subscribes through `listenValidated`, so a payload that
does not match its zod schema is dropped at the seam. `cancelYtDlpDownload` calls
`cancel_media_download(runId)`; the backend unwinds a cancel *as an error*, so `addMedia`
recognizes `YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE` and routes it to the notice channel rather
than the error modal. The user got the outcome they clicked for.

**The modal lock.** `closeAddMediaModal` refuses while any of `isAddingMedia`,
`isYtDlpRunning`, `isCancellingYtDlp`, `isGeneratingThumb` or `isLoadingYtDlpFormats` is set. This is
now UX only, closing the modal mid-run would discard a terminal the user is watching. It used to be
more than that: `THREAT-MODEL.md` recorded it as the one guarantee in that document resting on frontend
behavior, because it was what kept two creations from racing the reference-counted cleanup. The lock
in `library::cleanup` holds that property now, so a queue or a batch import is a UX question rather
than a correctness one.

### Changing the library folder

Entry point: Settings > Library folder. `useHomeController` overrides the settings hook's
`chooseLibraryPath` with the Home-level one so the UI guards run first; it reaches
`useAppSettingsActions.changeLibraryPath`, which delegates the decisions to the
`executeChangeLibraryPath` use-case (`src/use-cases/`):

1. `chooseLibraryDirectory()`: the native folder dialog, through the platform seam. Cancel
   returns `changed: false` and nothing else runs.
2. A filesystem root is refused. (The backend's `reject_filesystem_root` is the real guard;
   this one is there to fail before the round trip.)
3. `ensureDirectoryExists(selected)` returns the canonical path, which is what everything
   downstream compares against, not the string the dialog handed back.
4. Same as the current library -> `changed: false`.
5. A non-empty destination is refused when a library already exists.
6. No current library (first-time setup) -> `changed: true` with no migration to run.
7. Otherwise `migrateLibraryDirectory(old, new)`.

Backend side (`commands/library.rs`): the *old* path is the one verified against persisted
settings, since that is the directory the migration removes; a destination inside the app
config directory is refused; a commit marker is written next to the database before the old
directory goes, so a crash mid-move is self-healed by `reconcile_interrupted_migration` on the
next `get_app_settings`; and once the move succeeds the old directory's asset-scope grant is
revoked.

Back in the frontend, `updateStoredLibraryPath` persists **before** `setSettings` exposes the
new value. That order is required, not stylistic: the state change is what fires
`useAppSettings`'s effect calling `registerLibraryAssetScope`, and the backend validates that
request against the persisted library path. Persisting second would make a legitimate
registration fail.

Two outcomes surface to the user rather than only to the log. `oldDirectoryRetained` means the
copy succeeded but the old folder could not be removed, so a full duplicate of the media is
still on the old volume. And moving *back* to a folder released earlier in the same session
fails with `ASSET_SCOPE_RESTART_REQUIRED_ERROR_CODE` (the asset scope cannot un-forbid a
directory), which is the one asset-scope failure worth interrupting the user for, because the
fix is a restart and nothing would suggest it.

### Database recovery at startup

Two of the three steps happen before the frontend exists at all. `lib.rs`'s `setup()` runs
`resume_interrupted_restore` and then `apply_pending_database_import`, in that order and both
before the pool can open. A pending import has to set the *restored* database aside as its
undo snapshot, not the one the interrupted restore left behind.

The frontend's part is `useAppBootstrap`, whose effect calls `ensureDatabaseReady()`. That
resolves to `db.pool()`, i.e. `build_pool_at`: the `quick_check` gate when a migration is
pending, the pre-migration snapshot, the open, and `ensure_schema`. So a failure here can mean
corruption, a failed migration, or a database this build refuses.

The hook branches on which:

- `DATABASE_SCHEMA_TOO_NEW` shows an "update Kavynex" message and **deliberately does not offer
  a restore**. That database is fine, just newer; restoring would replace a good database with
  an older snapshot.
- Anything else asks `getDatabaseBackupStatus()`. If a backup exists, the recovery modal opens
  showing its date; otherwise the initialization error is surfaced as-is.

`restoreFromBackup` calls `restore_database_from_backup` (which refuses to run once the pool is
open, and holds the open lock for the whole restore so nothing can create the file underneath
it) and then reloads the window, so the app re-initializes against the restored database rather
than continuing on the half-loaded state the failed startup left.

One related path does not go through this hook: `useDatabaseIntegrityAlert` subscribes to
`database-integrity-failed`, which the background weekly full `integrity_check` emits when it
finds damage a `quick_check` passed. That is a warning pointing at Settings > Database, not a
recovery flow. The database opened fine.

See `docs/DATABASE.md` for the backup, restore and import rules these three steps follow.

## Where to look for what

| Concern | Backend | Frontend |
|---|---|---|
| Channels CRUD | `commands/channels.rs`, `services/channel_repository.rs` | `repositories/channel-repository.ts` |
| Media CRUD | `commands/videos.rs`, `services/video_repository/` | `repositories/media-repository.ts`, `services/media-service.ts` |
| Creating a media (download or import, thumbnail, crash marker, row) | `commands/media.rs`, `services/media_creation.rs`, `services/library/media.rs` | `services/media-input-service.ts`, `hooks/use-add-media-workflow.ts` |
| yt-dlp downloads | `commands/yt_dlp.rs`, `services/yt_dlp/download/`, `services/yt_dlp/metadata.rs`, `services/yt_dlp/cookies.rs`, `services/yt_dlp/url.rs` | `services/media-download-service.ts`, `hooks/use-yt-dlp-events.ts` |
| Thumbnails | `commands/thumbnail.rs`, `services/thumbnail/persist.rs`, `services/thumbnail/download/` (`mod.rs`, `fetch.rs`, `process.rs`), `services/thumbnail/url.rs`, `services/thumbnail/redirect.rs`, `services/thumbnail/picked.rs`, `services/thumbnail/temp.rs`, `services/thumbnail/display.rs` | `services/thumbnail-service.ts`, `hooks/use-temp-thumbnail.ts`, `hooks/use-display-thumbnails.ts` |
| Live chat | `commands/live_chat.rs`, `services/live_chat_storage.rs` | `services/live-chat-service.ts`, `services/live-chat-parsing.ts` |
| Database schema/migrations | `services/db_schema/` |. |
| Database backup/restore/export/import | `commands/database.rs`, `services/db_backup/` | `services/database-service.ts` |
| Path safety / asset scope | `utils/path.rs`, `commands/security.rs` | `services/asset-scope-service.ts` |
| Diagnostics | `commands/library.rs`, `services/library/summary.rs`, `services/library/integrity.rs`, `services/library/cleanup.rs` | `services/diagnostics-*.ts`, `hooks/use-diagnostics.ts` |
| App settings | `commands/settings.rs`, `services/database.rs` | `services/app-settings-command-service.ts`, `hooks/settings/` |
| Crash recovery (leftovers from a run that did not finish) | `services/pending_media.rs`, `services/library/recovery.rs`, `services/temp_cleanup.rs` |. |
| Startup self-checks (`--smoke-test`, `--webview-check`) | `lib.rs`, `commands/webview_check.rs` | `lib/webview-check.ts` |

See `docs/DATABASE.md` for the schema/migration/backup model and `docs/DIRECTORIES.md` for
the on-disk layout these services read and write.
