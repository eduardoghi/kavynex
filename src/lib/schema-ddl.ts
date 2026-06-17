export const CHANNELS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL CHECK (TRIM(name) <> ''),
    youtube_handle TEXT NOT NULL UNIQUE CHECK (TRIM(youtube_handle) <> ''),
    avatar_path TEXT CHECK (avatar_path IS NULL OR TRIM(avatar_path) <> ''),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const VIDEOS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS videos (
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
)`;

export const VIDEO_COMMENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS video_comments (
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
)`;

export const VIDEO_LIVE_CHAT_MESSAGES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS video_live_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    message_id TEXT,
    message_offset_ms INTEGER NOT NULL DEFAULT 0,
    author_name TEXT NOT NULL,
    author_thumbnail TEXT,
    author_badges TEXT,
    message_text TEXT NOT NULL,
    timestamp_text TEXT,
    amount_text TEXT,
    header_primary_text TEXT,
    header_secondary_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
)`;

export const APP_SETTINGS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const SCHEMA_INDEXES_DDL = [
    `CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_channels_youtube_handle ON channels(youtube_handle)`,
    `CREATE INDEX IF NOT EXISTS idx_channels_avatar_path ON channels(avatar_path)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_thumbnail_path ON videos(thumbnail_path)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_channel_file_path_unique
        ON videos(channel_id, file_path)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_channel_thumb ON videos(channel_id, thumbnail_path)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_youtube_video_id ON videos(youtube_video_id)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_watched_at ON videos(watched_at)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_has_comments ON videos(has_comments)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_is_live ON videos(is_live)`,
    `CREATE INDEX IF NOT EXISTS idx_videos_has_live_chat ON videos(has_live_chat)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_channel_youtube_video_id_unique
        ON videos(channel_id, youtube_video_id)
        WHERE youtube_video_id IS NOT NULL AND TRIM(youtube_video_id) <> ''`,
    `CREATE INDEX IF NOT EXISTS idx_video_comments_video_id ON video_comments(video_id)`,
    `CREATE INDEX IF NOT EXISTS idx_video_comments_parent_comment_id ON video_comments(parent_comment_id)`,
    `CREATE INDEX IF NOT EXISTS idx_video_comments_comment_id ON video_comments(comment_id)`,
    `CREATE INDEX IF NOT EXISTS idx_video_live_chat_messages_video_id ON video_live_chat_messages(video_id)`,
    `CREATE INDEX IF NOT EXISTS idx_video_live_chat_messages_video_time ON video_live_chat_messages(video_id, message_offset_ms)`,
] as const;
