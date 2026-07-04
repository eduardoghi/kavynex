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

export type YtDlpComment = {
    comment_id: string | null;
    parent_comment_id: string | null;
    author_name: string;
    author_handle: string | null;
    author_channel_id: string | null;
    author_thumbnail: string | null;
    text: string;
    like_count: number;
    reply_count: number;
    is_author_uploader: boolean;
    is_favorited: boolean;
    is_pinned: boolean;
    is_edited: boolean;
    time_text: string | null;
    published_at: string | null;
};

export type YtDlpFormat = {
    format_id: string;
    display_name: string;
    ext: string;
    media_type: MediaType;
    has_video: boolean;
    has_audio: boolean;
    filesize_bytes: number | null;
    height: number | null;
    abr: number | null;
    tbr?: number | null;
    vcodec?: string | null;
    protocol?: string | null;
};

export type YtDlpFormatsResult = {
    suggested_title: string;
    formats: YtDlpFormat[];
    terminal_logs: string[];
};

export type DownloadedMediaResult = {
    file_path: string;
    suggested_title: string;
    youtube_video_id: string | null;
    published_at: string | null;
    media_type: MediaType;
    thumbnail_url: string | null;
    thumbnail_path: string | null;
    is_live: boolean;
    live_chat_file_path: string | null;
};

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