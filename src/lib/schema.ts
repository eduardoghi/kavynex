import type Database from "@tauri-apps/plugin-sql";
import {
    APP_SETTINGS_TABLE_DDL,
    CHANNELS_TABLE_DDL,
    SCHEMA_INDEXES_DDL,
    VIDEO_COMMENTS_TABLE_DDL,
    VIDEO_LIVE_CHAT_MESSAGES_TABLE_DDL,
    VIDEOS_TABLE_DDL,
} from "./schema-ddl";

let schemaReadyPromise: Promise<void> | null = null;

const SCHEMA_VERSION = 5;

const REQUIRED_INDEXES = SCHEMA_INDEXES_DDL.map((ddl) => {
    const match = ddl.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\S+)/i);
    if (!match) throw new Error(`invalid schema index DDL: ${ddl}`);
    return match[1] as string;
});

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

    await db.execute(`${CHANNELS_TABLE_DDL};`);
    await db.execute(`${VIDEOS_TABLE_DDL};`);
    await db.execute(`${VIDEO_COMMENTS_TABLE_DDL};`);
    await db.execute(`${VIDEO_LIVE_CHAT_MESSAGES_TABLE_DDL};`);
    await db.execute(`${APP_SETTINGS_TABLE_DDL};`);

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
    for (const ddl of SCHEMA_INDEXES_DDL) {
        await db.execute(`${ddl};`);
    }
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