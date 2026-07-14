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
  `library.rs`, `logging.rs`). A command's job is to take the request from IPC, open the
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
  than by a strict service/repository naming split - some files are "repositories" in
  spirit (`channel_repository.rs`, `video_repository.rs` hold the SQL), others are
  domain services (`library_media.rs`, `library_migration.rs`, `library_cleanup.rs`,
  `thumbnail_persist.rs`, `thumbnail_download.rs`, `yt_dlp_download.rs`,
  `yt_dlp_metadata.rs`, `yt_dlp_cookies.rs`, `yt_dlp_url.rs`, `live_chat_storage.rs`,
  `db_schema.rs`, `db_backup.rs`, `database.rs`, `binaries.rs`, `cleanup.rs`, `logger.rs`).
  All schema/query code lives here, never in `commands/`.
- **Utils** (`src-tauri/src/utils/`) are small, pure, dependency-free helpers reused
  across services:
  - `path.rs` - the path-safety primitives (sanitizing a relative path, canonicalizing and
    containment-checking a path against a base directory). See `docs/DATABASE.md` and
    `SECURITY.md` for how this backs the library/asset-scope guarantees.
  - `process.rs` - suppresses the flashing console window Windows would otherwise show
    when spawning a console child process (yt-dlp, ffmpeg) from a windowed app.
  - `hash.rs` - SHA-256 file hashing used for the content-addressed media/thumbnail
    filenames (see `docs/DIRECTORIES.md`).
  - `format.rs`, `task.rs`, `io.rs` - extension/media-type helpers, a `run_blocking`
    wrapper for moving blocking work off the async runtime, and small IO helpers.
- Below that, services call `sqlx` against the shared SQLite pool (`services/database.rs`),
  `std::fs` for the filesystem, and `std::process::Command` / `tokio::process::Command` to
  run yt-dlp and FFmpeg (resolved via `services/binaries.rs`).

`src-tauri/src/lib.rs` wires all of this together: it builds the Tauri app, registers every
command in `invoke_handler(tauri::generate_handler![...])`, and in `setup()` initializes the
file logger, applies any staged database import before the connection pool opens, authorizes
the cache directory in the asset-protocol scope, and spawns a background cleanup of stale
temp files. On `ExitRequested` it cancels any in-flight yt-dlp/FFmpeg downloads so they are
not left running as orphans.

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
Never hand-edit files under `src/types/generated/` - change the Rust type and regenerate.

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

(Alongside it, `src/lib/tauri-platform.ts` covers the non-IPC Tauri surfaces - dialogs, the
system opener, process relaunch, the updater, the app version, `convertFileSrc` - so those
never reach a component either. See "The Tauri boundary" below.)

- **Components** (`src/components/`) are presentation: they receive data and callbacks as
  props and render Mantine/React UI. They never call `invoke()` and never import
  `@tauri-apps` directly - only the two seam modules under `src/lib/` do.
- **Hooks** (`src/hooks/`) hold UI state and orchestration. `useHomeController`
  (`src/hooks/use-home-controller.tsx`) is the composition root for the main `Home` page:
  it wires together `useErrorModal`, `useAppBootstrap`, `useAppSettings`, `useChannels`,
  `useMediaLibrary`, `useDiagnostics`, and a handful of `useHome*` hooks that derive
  view/panel state and actions from those slices, then returns a single `HomeController`
  object consumed by `src/pages/Home.tsx`.
- **Use-cases** (`src/use-cases/`) capture a business operation that spans more than one
  repository/service call as a single named function (e.g. `create-channel.ts`,
  `delete-media.ts`, `mark-media-watched.ts`, `change-library-path.ts`,
  `initialize-app-settings.ts`). Hooks call into use-cases for these flows instead of
  inlining multi-step orchestration.
- **Services** (`src/services/`) wrap a feature area's behavior on top of one or more
  repositories/commands - e.g. `media-download-service.ts`, `thumbnail-service.ts`,
  `library-service.ts`, `live-chat-service.ts`, `diagnostics-service.ts`,
  `app-update-service.ts`. Some call `invokeCommand`/`invokeVoid` directly for commands
  that are not backed by a `videos`/`channels` table row (thumbnails, yt-dlp runs,
  database backup/restore, settings).
- **Repositories** (`src/repositories/channel-repository.ts`,
  `src/repositories/media-repository.ts`) are the thin, typed layer directly over a
  database-backed Tauri command (`listChannels`, `insertChannel`,
  `deleteChannelWithArtifacts`, etc.) - one function per command, no business logic.
- **`src/lib/tauri-client.ts`** is the IPC boundary: `invokeTauri`/`invokeCommand`/
  `invokeVoid` wrap `@tauri-apps/api/core`'s `invoke()` (normalizing thrown errors through
  `parseAppError`) and `listenTauri` wraps `@tauri-apps/api/event`'s `listen()`. Every
  repository and IPC-calling service goes through these three functions.
- **`src/lib/tauri-platform.ts`** is the sibling seam for Tauri's *platform* capabilities -
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
"which Tauri capabilities does this app actually use?" - the question every review against
`src-tauri/capabilities/` has to answer - a two-file read instead of a tree-wide grep that
any new caller could silently invalidate. A test that needs to stub a Tauri call mocks the
seam module (`vi.mock("../lib/tauri-platform", ...)`), never the `@tauri-apps` package.

## Where to look for what

| Concern | Backend | Frontend |
|---|---|---|
| Channels CRUD | `commands/channels.rs`, `services/channel_repository.rs` | `repositories/channel-repository.ts` |
| Media CRUD / import | `commands/videos.rs`, `commands/media.rs`, `services/video_repository.rs`, `services/library_media.rs` | `repositories/media-repository.ts`, `services/media-file-service.ts`, `services/media-input-service.ts` |
| yt-dlp downloads | `commands/yt_dlp.rs`, `services/yt_dlp_download.rs`, `services/yt_dlp_metadata.rs`, `services/yt_dlp_cookies.rs`, `services/yt_dlp_url.rs` | `services/media-download-service.ts`, `hooks/use-yt-dlp-events.ts` |
| Thumbnails | `commands/thumbnail.rs`, `services/thumbnail_persist.rs`, `services/thumbnail_download.rs`, `services/thumbnail_temp.rs` | `services/thumbnail-service.ts`, `hooks/use-temp-thumbnail.ts` |
| Live chat | `commands/live_chat.rs`, `services/live_chat_storage.rs` | `services/live-chat-service.ts` |
| Database schema/migrations | `services/db_schema.rs` | - |
| Database backup/restore/export/import | `commands/database.rs`, `services/db_backup.rs` | `services/database-service.ts` |
| Path safety / asset scope | `utils/path.rs`, `commands/security.rs` | `services/asset-scope-service.ts` |
| Diagnostics | `commands/library.rs`, `services/library_summary.rs`, `services/library_cleanup.rs` | `services/diagnostics-*.ts`, `hooks/use-diagnostics.ts` |
| App settings | `commands/settings.rs`, `services/database.rs` | `services/app-settings-command-service.ts`, `hooks/use-app-settings*.ts` |

See `docs/DATABASE.md` for the schema/migration/backup model and `docs/DIRECTORIES.md` for
the on-disk layout these services read and write.
