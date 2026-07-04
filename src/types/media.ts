export type MediaType = "video" | "audio";

export type MediaSourceMode = "local" | "yt-dlp";
export type ViewMode = "library" | "player";
export type ChannelAvatarMode = "none" | "manual" | "youtube";

// Generated from the Rust `MediaRow` struct by ts-rs (see src-tauri/.../video_repository.rs).
// Do not hand-edit the shape here; change the Rust struct and regenerate.
export type { MediaRow } from "./generated/MediaRow";

// Generated from the Rust `MediaCommentRow` struct by ts-rs. Change the Rust struct and
// regenerate; do not hand-edit the shape here.
export type { MediaCommentRow } from "./generated/MediaCommentRow";

// Generated from the Rust structs by ts-rs (YtDlpFormat comes from `YtDlpFormatOption`).
// Change the Rust struct and regenerate; do not hand-edit the shapes here.
export type { YtDlpComment } from "./generated/YtDlpComment";
export type { YtDlpFormat } from "./generated/YtDlpFormat";
export type { YtDlpFormatsResult } from "./generated/YtDlpFormatsResult";
export type { DownloadedMediaResult } from "./generated/DownloadedMediaResult";

// Generated yt-dlp event payload types (from models/yt_dlp.rs). These were previously
// duplicated here and in use-yt-dlp-events.ts; both now share the generated types.
export type { YtDlpLogEvent } from "./generated/YtDlpLogEvent";
export type { YtDlpFinishedEvent } from "./generated/YtDlpFinishedEvent";
export type { YtDlpFailedEvent } from "./generated/YtDlpFailedEvent";
export type { YtDlpTerminalEvent } from "./generated/YtDlpTerminalEvent";

// Generated from the Rust `ChannelRow` struct by ts-rs (exported as `Channel`).
export type { Channel } from "./generated/Channel";