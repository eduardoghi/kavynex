import type { Channel } from "../types/media";
import { getDb } from "../lib/db";

export async function listChannels(): Promise<Channel[]> {
    const db = await getDb();

    return db.select<Channel[]>(
        `SELECT
            id,
            name,
            youtube_handle,
            avatar_path,
            created_at
         FROM channels
         ORDER BY name ASC`
    );
}

export async function findChannelByYoutubeHandle(
    youtubeHandle: string
): Promise<Channel | null> {
    const db = await getDb();

    const rows = await db.select<Channel[]>(
        `SELECT
            id,
            name,
            youtube_handle,
            avatar_path,
            created_at
         FROM channels
         WHERE youtube_handle = ?
         LIMIT 1`,
        [youtubeHandle]
    );

    return rows[0] ?? null;
}

export async function getChannelById(channelId: number): Promise<Channel | null> {
    const db = await getDb();

    const rows = await db.select<Channel[]>(
        `SELECT
            id,
            name,
            youtube_handle,
            avatar_path,
            created_at
         FROM channels
         WHERE id = ?
         LIMIT 1`,
        [channelId]
    );

    return rows[0] ?? null;
}

export async function insertChannel(
    name: string,
    youtubeHandle: string,
    avatarPath: string | null
): Promise<number | null> {
    const db = await getDb();

    const result = await db.execute(
        `INSERT INTO channels (
            name,
            youtube_handle,
            avatar_path
         ) VALUES (?, ?, ?)`,
        [name, youtubeHandle, avatarPath]
    );

    const insertedId =
        typeof result.lastInsertId === "number" && result.lastInsertId > 0
            ? result.lastInsertId
            : null;

    return insertedId;
}

export async function updateChannelNameAndHandle(
    channelId: number,
    name: string,
    youtubeHandle: string
): Promise<void> {
    const db = await getDb();

    await db.execute(
        `UPDATE channels
         SET name = ?,
             youtube_handle = ?
         WHERE id = ?`,
        [name, youtubeHandle, channelId]
    );
}

export async function updateChannelAvatarPath(
    channelId: number,
    avatarPath: string | null
): Promise<void> {
    const db = await getDb();

    await db.execute(
        `UPDATE channels
         SET avatar_path = ?
         WHERE id = ?`,
        [avatarPath, channelId]
    );
}

export async function deleteChannelById(channelId: number): Promise<void> {
    const db = await getDb();
    await db.execute(`DELETE FROM channels WHERE id = ?`, [channelId]);
}

export async function listDistinctThumbnailPathsByChannelId(
    channelId: number
): Promise<string[]> {
    const db = await getDb();

    const rows = await db.select<{ thumbnail_path: string }[]>(
        `SELECT DISTINCT thumbnail_path
         FROM videos
         WHERE channel_id = ?
           AND thumbnail_path IS NOT NULL
           AND TRIM(thumbnail_path) <> ''`,
        [channelId]
    );

    return rows.map((row) => row.thumbnail_path);
}

export async function listDistinctFilePathsByChannelId(
    channelId: number
): Promise<string[]> {
    const db = await getDb();

    const rows = await db.select<{ file_path: string }[]>(
        `SELECT DISTINCT file_path
         FROM videos
         WHERE channel_id = ?
           AND file_path IS NOT NULL
           AND TRIM(file_path) <> ''`,
        [channelId]
    );

    return rows.map((row) => row.file_path);
}

export async function getChannelAvatarPathByChannelId(
    channelId: number
): Promise<string | null> {
    const db = await getDb();

    const rows = await db.select<{ avatar_path: string | null }[]>(
        `SELECT avatar_path
         FROM channels
         WHERE id = ?
         LIMIT 1`,
        [channelId]
    );

    return rows[0]?.avatar_path ?? null;
}

export async function countChannelsUsingAvatarPathOutsideChannel(
    avatarPath: string,
    channelId: number
): Promise<number> {
    const db = await getDb();

    const rows = await db.select<{ total: number }[]>(
        `SELECT COUNT(*) AS total
         FROM channels
         WHERE avatar_path = ?
           AND id <> ?`,
        [avatarPath, channelId]
    );

    return Number(rows[0]?.total ?? 0);
}

export async function countMediaUsingThumbnailOutsideChannel(
    thumbnailPath: string,
    channelId: number
): Promise<number> {
    const db = await getDb();

    const rows = await db.select<{ total: number }[]>(
        `SELECT COUNT(*) AS total
         FROM videos
         WHERE thumbnail_path = ?
           AND channel_id <> ?`,
        [thumbnailPath, channelId]
    );

    return Number(rows[0]?.total ?? 0);
}

export async function countMediaUsingFilePathOutsideChannel(
    filePath: string,
    channelId: number
): Promise<number> {
    const db = await getDb();

    const rows = await db.select<{ total: number }[]>(
        `SELECT COUNT(*) AS total
         FROM videos
         WHERE file_path = ?
           AND channel_id <> ?`,
        [filePath, channelId]
    );

    return Number(rows[0]?.total ?? 0);
}