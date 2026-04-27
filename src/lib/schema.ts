import type Database from "@tauri-apps/plugin-sql";

let schemaReadyPromise: Promise<void> | null = null;

const SCHEMA_VERSION = 5;

const REQUIRED_INDEXES = [
    "idx_videos_channel_id",
    "idx_channels_youtube_handle",
    "idx_channels_avatar_path",
    "idx_videos_thumbnail_path",
    "idx_videos_channel_thumb",
    "idx_videos_youtube_video_id",
    "idx_videos_watched_at",
    "idx_videos_published_at",
    "idx_videos_has_comments",
    "idx_videos_is_live",
    "idx_videos_has_live_chat",
    "idx_videos_channel_youtube_video_id_unique",
    "idx_video_comments_video_id",
    "idx_video_comments_parent_comment_id",
    "idx_video_comments_comment_id",
    "idx_video_live_chat_messages_video_id",
    "idx_video_live_chat_messages_video_time",
] as const;

type IndexListRow = {
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
};

async function tableExists(db: Database, tableName: string): Promise<boolean> {
    const rows = await db.select<{ total: number }[]>(
        `SELECT COUNT(*) AS total
         FROM sqlite_master
         WHERE type = 'table'
           AND name = ?`,
        [tableName]
    );

    return Number(rows[0]?.total ?? 0) > 0;
}

async function tableHasColumn(
    db: Database,
    tableName: string,
    columnName: string
): Promise<boolean> {
    const rows = await db.select<
        {
            cid: number;
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
        }[]
    >(`PRAGMA table_info(${tableName});`);

    return rows.some((row) => row.name === columnName);
}

async function indexExists(db: Database, tableName: string, indexName: string): Promise<boolean> {
    const rows = await db.select<IndexListRow[]>(`PRAGMA index_list(${tableName});`);
    return rows.some((row) => row.name === indexName);
}

async function ensureColumnIfMissing(
    db: Database,
    tableName: string,
    columnName: string,
    definition: string
): Promise<void> {
    const exists = await tableHasColumn(db, tableName, columnName);

    if (exists) {
        return;
    }

    await db.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
}

async function ensureBaseSchema(db: Database): Promise<void> {
    await db.execute(`PRAGMA foreign_keys = ON;`);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL CHECK (TRIM(name) <> ''),
            youtube_handle TEXT NOT NULL UNIQUE CHECK (TRIM(youtube_handle) <> ''),
            avatar_path TEXT CHECK (avatar_path IS NULL OR TRIM(avatar_path) <> ''),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS videos (
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
        );
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS video_comments (
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
        );
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS video_live_chat_messages (
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
        );
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    await ensureColumnIfMissing(db, "videos", "is_live", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumnIfMissing(db, "videos", "has_live_chat", "INTEGER NOT NULL DEFAULT 0");
    await ensureColumnIfMissing(
        db,
        "videos",
        "live_chat_file_path",
        "TEXT CHECK (live_chat_file_path IS NULL OR TRIM(live_chat_file_path) <> '')"
    );

    await ensureRequiredIndexes(db);
}

async function ensureRequiredIndexes(db: Database): Promise<void> {
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);`);
    await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_channels_youtube_handle ON channels(youtube_handle);`
    );
    await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_channels_avatar_path ON channels(avatar_path);`
    );
    await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_videos_thumbnail_path ON videos(thumbnail_path);`
    );
    await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_videos_channel_thumb ON videos(channel_id, thumbnail_path);`
    );
    await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_videos_youtube_video_id ON videos(youtube_video_id);`
    );
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_videos_watched_at ON videos(watched_at);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_videos_has_comments ON videos(has_comments);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_videos_is_live ON videos(is_live);`);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_videos_has_live_chat ON videos(has_live_chat);`);
    await db.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_channel_youtube_video_id_unique
        ON videos(channel_id, youtube_video_id)
        WHERE youtube_video_id IS NOT NULL AND TRIM(youtube_video_id) <> '';
    `);
    await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_video_comments_video_id
        ON video_comments(video_id);
    `);
    await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_video_comments_parent_comment_id
        ON video_comments(parent_comment_id);
    `);
    await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_video_comments_comment_id
        ON video_comments(comment_id);
    `);
    await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_video_live_chat_messages_video_id
        ON video_live_chat_messages(video_id);
    `);
    await db.execute(`
        CREATE INDEX IF NOT EXISTS idx_video_live_chat_messages_video_time
        ON video_live_chat_messages(video_id, message_offset_ms);
    `);
}

async function schemaMatchesCurrentVersion(db: Database): Promise<boolean> {
    const channelsExists = await tableExists(db, "channels");
    const videosExists = await tableExists(db, "videos");
    const videoCommentsExists = await tableExists(db, "video_comments");
    const videoLiveChatMessagesExists = await tableExists(db, "video_live_chat_messages");
    const appSettingsExists = await tableExists(db, "app_settings");

    if (
        !channelsExists ||
        !videosExists ||
        !videoCommentsExists ||
        !videoLiveChatMessagesExists ||
        !appSettingsExists
    ) {
        return false;
    }

    const requiredChannelsColumns = ["id", "name", "youtube_handle", "avatar_path", "created_at"];
    const requiredVideosColumns = [
        "id",
        "channel_id",
        "title",
        "file_path",
        "thumbnail_path",
        "media_type",
        "youtube_video_id",
        "watched_at",
        "published_at",
        "duration_seconds",
        "progress_seconds",
        "has_comments",
        "comments_count",
        "is_live",
        "has_live_chat",
        "live_chat_file_path",
        "created_at",
    ];
    const requiredVideoCommentsColumns = [
        "id",
        "video_id",
        "comment_id",
        "parent_comment_id",
        "author_name",
        "author_handle",
        "author_channel_id",
        "author_thumbnail",
        "text",
        "like_count",
        "reply_count",
        "is_author_uploader",
        "is_favorited",
        "is_pinned",
        "is_edited",
        "time_text",
        "published_at",
        "created_at",
    ];
    const requiredVideoLiveChatMessageColumns = [
        "id",
        "video_id",
        "message_id",
        "message_offset_ms",
        "author_name",
        "author_thumbnail",
        "author_badges",
        "message_text",
        "timestamp_text",
        "amount_text",
        "header_primary_text",
        "header_secondary_text",
        "created_at",
    ];
    const requiredAppSettingsColumns = ["key", "value", "created_at", "updated_at"];

    for (const column of requiredChannelsColumns) {
        if (!(await tableHasColumn(db, "channels", column))) {
            return false;
        }
    }

    for (const column of requiredVideosColumns) {
        if (!(await tableHasColumn(db, "videos", column))) {
            return false;
        }
    }

    for (const column of requiredVideoCommentsColumns) {
        if (!(await tableHasColumn(db, "video_comments", column))) {
            return false;
        }
    }

    for (const column of requiredVideoLiveChatMessageColumns) {
        if (!(await tableHasColumn(db, "video_live_chat_messages", column))) {
            return false;
        }
    }

    for (const column of requiredAppSettingsColumns) {
        if (!(await tableHasColumn(db, "app_settings", column))) {
            return false;
        }
    }

    const channelIndexes = REQUIRED_INDEXES.filter((item) => item.startsWith("idx_channels_"));
    const videoIndexes = REQUIRED_INDEXES.filter((item) => item.startsWith("idx_videos_"));
    const commentIndexes = REQUIRED_INDEXES.filter((item) => item.startsWith("idx_video_comments_"));
    const liveChatIndexes = REQUIRED_INDEXES.filter((item) =>
        item.startsWith("idx_video_live_chat_messages_")
    );

    for (const indexName of channelIndexes) {
        if (!(await indexExists(db, "channels", indexName))) {
            return false;
        }
    }

    for (const indexName of videoIndexes) {
        if (!(await indexExists(db, "videos", indexName))) {
            return false;
        }
    }

    for (const indexName of commentIndexes) {
        if (!(await indexExists(db, "video_comments", indexName))) {
            return false;
        }
    }

    for (const indexName of liveChatIndexes) {
        if (!(await indexExists(db, "video_live_chat_messages", indexName))) {
            return false;
        }
    }

    return true;
}

async function setUserVersion(db: Database, version: number): Promise<void> {
    await db.execute(`PRAGMA user_version = ${version};`);
}

async function applySchema(db: Database): Promise<void> {
    await db.execute(`PRAGMA foreign_keys = ON;`);
    await ensureBaseSchema(db);

    const alreadyCurrent = await schemaMatchesCurrentVersion(db);

    if (!alreadyCurrent) {
        throw new Error("Database schema does not match the expected version.");
    }

    await setUserVersion(db, SCHEMA_VERSION);
}

export async function ensureSchema(db: Database): Promise<void> {
    if (!schemaReadyPromise) {
        schemaReadyPromise = applySchema(db).catch((error) => {
            schemaReadyPromise = null;
            throw error;
        });
    }

    return schemaReadyPromise;
}