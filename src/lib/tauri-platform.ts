// The single place the frontend touches Tauri's *platform* capabilities. The app version and asset
// URL conversion. File dialogs, the system opener, the updater and the relaunch are not here. They
// are backend commands (services/file-dialog-service.ts, openYoutubeVideo in
// services/library-service.ts, services/app-update-service.ts), because the dialog plugin's own
// commands add every picked path to the asset scope, the opener's would take any URL the renderer
// builds, and the updater's take a proxy and headers from the caller.
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
// These are deliberate re-exports, not wrappers. Each keeps the exact signature and behavior, so
// routing a caller through here is a pure import change with nothing new to go wrong. Error
// normalization belongs to the IPC seam, which is where `AppError` is produced.

export { convertFileSrc } from "@tauri-apps/api/core";
export { getVersion } from "@tauri-apps/api/app";
