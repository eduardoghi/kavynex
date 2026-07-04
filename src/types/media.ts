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

export type YtDlpLogEvent = {
    run_id: string;
    line: string;
    stream: string;
    level?: "info" | "warn" | "error";
};

export type YtDlpFinishedEvent = {
    run_id: string;
    file_path: string;
    suggested_title: string;
};

export type YtDlpFailedEvent = {
    run_id: string;
    message: string;
};

// Generated from the Rust `ChannelRow` struct by ts-rs (exported as `Channel`).
export type { Channel } from "./generated/Channel";