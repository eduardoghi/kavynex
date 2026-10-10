// The single place the frontend touches Tauri's *platform* capabilities. Process relaunch, the
// updater, the app version, and asset URL conversion. File dialogs and the system opener are not
// here. They are backend commands (services/file-dialog-service.ts, and openYoutubeVideo in
// services/library-service.ts), because the dialog plugin's own commands add every picked path to
// the asset scope and the opener's would take any URL the renderer builds.
// Calls into our own Rust backend (commands and events) go through the sibling IPC seam,
// `tauri-client.ts`, instead.
//
// Why both modules exist and why nothing else may import `@tauri-apps`. Keeping every such
// import inside `src/lib/` makes "what Tauri capabilities does this app actually use?" (the
// question behind every capability/permission review against `src-tauri/capabilities/`), a
// two-file read rather than a tree-wide grep that a new caller can silently invalidate.
// `eslint.config.js`'s `no-restricted-imports` rule enforces it, so a bypass fails lint
// instead of relying on code review.
//
// These are deliberate re-exports, not wrappers. Each keeps the plugin's exact signature and
// behavior, so routing a caller through here is a pure import change with nothing new to go
// wrong. Error normalization belongs to the IPC seam, which is where `AppError` is produced;
// a plugin rejection stays whatever the plugin threw and is handled at the call site (the
// updater callers already catch and route through `resolveErrorMessage`).
//
// The updater entry point is re-exported under a clearer name. A bare `check` says nothing about
// what it acts on once it is imported somewhere else.

export { convertFileSrc } from "@tauri-apps/api/core";
export { getVersion } from "@tauri-apps/api/app";
export { relaunch } from "@tauri-apps/plugin-process";
export { check as checkForAppUpdate, type Update } from "@tauri-apps/plugin-updater";
