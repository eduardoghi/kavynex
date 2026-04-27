export type MediaType = "video" | "audio";

export type MediaSourceMode = "local" | "yt-dlp";
export type ViewMode = "library" | "player";
export type ChannelAvatarMode = "none" | "manual" | "youtube";

export type MediaRow = {
    id: number;
    channel_id: number;
    title: string;
    file_path: string;
    thumbnail_path: string | null;
    media_type: MediaType;
    youtube_video_id: string | null;
    watched_at: string | null;
    published_at: string | null;
    duration_seconds: number | null;
    progress_seconds: number;
    has_comments: number;
    comments_count: number;
    is_live: number;
    has_live_chat: number;
    live_chat_file_path: string | null;
    created_at: string;
};

export type MediaCommentRow = {
    id: number;
    video_id: number;
    comment_id: string | null;
    parent_comment_id: string | null;
    author_name: string;
    author_handle: string | null;
    author_channel_id: string | null;
    author_thumbnail: string | null;
    text: string;
    like_count: number;
    reply_count: number;
    is_author_uploader: number;
    is_favorited: number;
    is_pinned: number;
    is_edited: number;
    time_text: string | null;
    published_at: string | null;
    created_at: string;
};

export type LiveChatMessageRow = {
    id: number;
    video_id: number;
    message_id: string | null;
    message_offset_ms: number;
    author_name: string;
    author_thumbnail: string | null;
    author_badges: string | null;
    message_text: string;
    timestamp_text: string | null;
    amount_text: string | null;
    header_primary_text: string | null;
    header_secondary_text: string | null;
    created_at: string;
};

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

export type Channel = {
    id: number;
    name: string;
    youtube_handle: string;
    avatar_path: string | null;
    created_at: string;
};