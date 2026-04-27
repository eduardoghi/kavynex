import type { MediaCommentRow, MediaRow, MediaType, YtDlpComment } from "../types/media";
import { getDb } from "../lib/db";
import type { MediaIntegrityReference, MediaRepositoryStats } from "../types/diagnostics";

export async function updateMediaTitle(mediaId: number, title: string): Promise<void> {
    const db = await getDb();

    await db.execute(
        `UPDATE videos
         SET title = ?
         WHERE id = ?`,
        [title, mediaId]
    );
}

export async function listMediaByChannel(channelId: number): Promise<MediaRow[]> {
    const db = await getDb();

    return db.select<MediaRow[]>(
        `SELECT
            id,
            channel_id,
            title,
            file_path,
            thumbnail_path,
            media_type,
            youtube_video_id,
            watched_at,
            published_at,
            duration_seconds,
            progress_seconds,
            has_comments,
            comments_count,
            is_live,
            has_live_chat,
            live_chat_file_path,
            created_at
         FROM videos
         WHERE channel_id = ?
         ORDER BY created_at DESC, id DESC`,
        [channelId]
    );
}

export async function findMediaByChannelAndFilePath(
    channelId: number,
    filePath: string
): Promise<MediaRow | null> {
    const db = await getDb();

    const rows = await db.select<MediaRow[]>(
        `SELECT
            id,
            channel_id,
            title,
            file_path,
            thumbnail_path,
            media_type,
            youtube_video_id,
            watched_at,
            published_at,
            duration_seconds,
            progress_seconds,
            has_comments,
            comments_count,
            is_live,
            has_live_chat,
            live_chat_file_path,
            created_at
         FROM videos
         WHERE channel_id = ?
           AND file_path = ?
         LIMIT 1`,
        [channelId, filePath]
    );

    return rows[0] ?? null;
}

export async function insertMedia(
    channelId: number,
    title: string,
    filePath: string,
    thumbnailPath: string | null,
    mediaType: MediaType,
    youtubeVideoId: string | null,
    publishedAt: string | null,
    durationSeconds: number | null,
    isLive: boolean,
    liveChatFilePath: string | null
): Promise<number | null> {
    const db = await getDb();
    const hasLiveChat = Boolean(liveChatFilePath?.trim());

    await db.execute(
        `INSERT INTO videos (
            channel_id,
            title,
            file_path,
            thumbnail_path,
            media_type,
            youtube_video_id,
            published_at,
            duration_seconds,
            progress_seconds,
            has_comments,
            comments_count,
            is_live,
            has_live_chat,
            live_chat_file_path
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            channelId,
            title,
            filePath,
            thumbnailPath,
            mediaType,
            youtubeVideoId,
            publishedAt,
            durationSeconds,
            0,
            0,
            0,
            isLive ? 1 : 0,
            hasLiveChat ? 1 : 0,
            liveChatFilePath?.trim() || null,
        ]
    );

    const rows = await db.select<{ id: number }[]>(
        `SELECT id
         FROM videos
         WHERE channel_id = ?
           AND file_path = ?
         ORDER BY id DESC
         LIMIT 1`,
        [channelId, filePath]
    );

    return rows[0]?.id ?? null;
}

export async function replaceMediaComments(
    mediaId: number,
    comments: YtDlpComment[]
): Promise<void> {
    const db = await getDb();

    await db.execute(`DELETE FROM video_comments WHERE video_id = ?`, [mediaId]);

    for (const comment of comments) {
        const normalizedText = comment.text.trim();

        if (!normalizedText) {
            continue;
        }

        await db.execute(
            `INSERT INTO video_comments (
                video_id,
                comment_id,
                parent_comment_id,
                author_name,
                author_handle,
                author_channel_id,
                author_thumbnail,
                text,
                like_count,
                reply_count,
                is_author_uploader,
                is_favorited,
                is_pinned,
                is_edited,
                time_text,
                published_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                mediaId,
                comment.comment_id?.trim() || null,
                comment.parent_comment_id?.trim() || null,
                comment.author_name.trim() || "Unknown author",
                comment.author_handle?.trim() || null,
                comment.author_channel_id?.trim() || null,
                comment.author_thumbnail?.trim() || null,
                normalizedText,
                Math.max(0, Math.floor(comment.like_count ?? 0)),
                Math.max(0, Math.floor(comment.reply_count ?? 0)),
                comment.is_author_uploader ? 1 : 0,
                comment.is_favorited ? 1 : 0,
                comment.is_pinned ? 1 : 0,
                comment.is_edited ? 1 : 0,
                comment.time_text?.trim() || null,
                comment.published_at?.trim() || null,
            ]
        );
    }

    const rows = await db.select<{ total: number }[]>(
        `SELECT COUNT(*) AS total
         FROM video_comments
         WHERE video_id = ?`,
        [mediaId]
    );

    const total = Number(rows[0]?.total ?? 0);

    await db.execute(
        `UPDATE videos
         SET has_comments = ?,
             comments_count = ?
         WHERE id = ?`,
        [total > 0 ? 1 : 0, total, mediaId]
    );
}

export async function listMediaCommentsByMediaId(mediaId: number): Promise<MediaCommentRow[]> {
    const db = await getDb();

    return db.select<MediaCommentRow[]>(
        `SELECT
            id,
            video_id,
            comment_id,
            parent_comment_id,
            author_name,
            author_handle,
            author_channel_id,
            author_thumbnail,
            text,
            like_count,
            reply_count,
            is_author_uploader,
            is_favorited,
            is_pinned,
            is_edited,
            time_text,
            published_at,
            created_at
         FROM video_comments
         WHERE video_id = ?
         ORDER BY id ASC`,
        [mediaId]
    );
}

export async function deleteMediaById(mediaId: number): Promise<void> {
    const db = await getDb();
    await db.execute(`DELETE FROM videos WHERE id = ?`, [mediaId]);
}

export async function markMediaAsWatched(mediaId: number): Promise<void> {
    const db = await getDb();

    await db.execute(
        `UPDATE videos
         SET watched_at = CURRENT_TIMESTAMP,
             progress_seconds = 0
         WHERE id = ?`,
        [mediaId]
    );
}

export async function markMediaAsUnwatched(mediaId: number): Promise<void> {
    const db = await getDb();

    await db.execute(
        `UPDATE videos
         SET watched_at = NULL
         WHERE id = ?`,
        [mediaId]
    );
}

export async function updateMediaProgress(
    mediaId: number,
    progressSeconds: number
): Promise<void> {
    const db = await getDb();

    await db.execute(
        `UPDATE videos
         SET progress_seconds = ?
         WHERE id = ?
           AND watched_at IS NULL`,
        [progressSeconds, mediaId]
    );
}

export async function countMediaUsingThumbnailOutsideMedia(
    thumbnailPath: string,
    mediaId: number
): Promise<number> {
    const db = await getDb();

    const rows = await db.select<{ total: number }[]>(
        `SELECT COUNT(*) AS total
         FROM videos
         WHERE thumbnail_path = ?
           AND id <> ?`,
        [thumbnailPath, mediaId]
    );

    return Number(rows[0]?.total ?? 0);
}

export async function countMediaUsingFilePathOutsideMedia(
    filePath: string,
    mediaId: number
): Promise<number> {
    const db = await getDb();

    const rows = await db.select<{ total: number }[]>(
        `SELECT COUNT(*) AS total
         FROM videos
         WHERE file_path = ?
           AND id <> ?`,
        [filePath, mediaId]
    );

    return Number(rows[0]?.total ?? 0);
}

export async function getMediaRepositoryStats(): Promise<MediaRepositoryStats> {
    const db = await getDb();

    const rows = await db.select<MediaRepositoryStats[]>(
        `SELECT
            COUNT(*) AS total_media,
            SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS total_video_media,
            SUM(CASE WHEN media_type = 'audio' THEN 1 ELSE 0 END) AS total_audio_media,
            SUM(
                CASE
                    WHEN thumbnail_path IS NOT NULL AND TRIM(thumbnail_path) <> '' THEN 1
                    ELSE 0
                END
            ) AS total_with_thumbnail,
            SUM(
                CASE
                    WHEN thumbnail_path IS NULL OR TRIM(thumbnail_path) = '' THEN 1
                    ELSE 0
                END
            ) AS total_without_thumbnail,
            SUM(
                CASE
                    WHEN watched_at IS NOT NULL AND TRIM(watched_at) <> '' THEN 1
                    ELSE 0
                END
            ) AS total_watched,
            SUM(
                CASE
                    WHEN watched_at IS NULL OR TRIM(watched_at) = '' THEN 1
                    ELSE 0
                END
            ) AS total_unwatched,
            SUM(
                CASE
                    WHEN is_live = 1 THEN 1
                    ELSE 0
                END
            ) AS total_live_media,
            SUM(
                CASE
                    WHEN has_live_chat = 1 THEN 1
                    ELSE 0
                END
            ) AS total_with_live_chat,
            SUM(
                CASE
                    WHEN has_live_chat = 0 THEN 1
                    ELSE 0
                END
            ) AS total_without_live_chat,
            SUM(
                CASE
                    WHEN has_live_chat = 1
                     AND (live_chat_file_path IS NULL OR TRIM(live_chat_file_path) = '')
                    THEN 1
                    ELSE 0
                END
            ) AS total_media_with_live_chat_flag_but_no_path,
            SUM(
                CASE
                    WHEN is_live = 0
                     AND live_chat_file_path IS NOT NULL
                     AND TRIM(live_chat_file_path) <> ''
                    THEN 1
                    ELSE 0
                END
            ) AS total_media_with_live_chat_path_but_not_live
         FROM videos`
    );

    return {
        total_media: Number(rows[0]?.total_media ?? 0),
        total_video_media: Number(rows[0]?.total_video_media ?? 0),
        total_audio_media: Number(rows[0]?.total_audio_media ?? 0),
        total_with_thumbnail: Number(rows[0]?.total_with_thumbnail ?? 0),
        total_without_thumbnail: Number(rows[0]?.total_without_thumbnail ?? 0),
        total_watched: Number(rows[0]?.total_watched ?? 0),
        total_unwatched: Number(rows[0]?.total_unwatched ?? 0),
        total_live_media: Number(rows[0]?.total_live_media ?? 0),
        total_with_live_chat: Number(rows[0]?.total_with_live_chat ?? 0),
        total_without_live_chat: Number(rows[0]?.total_without_live_chat ?? 0),
        total_media_with_live_chat_flag_but_no_path: Number(
            rows[0]?.total_media_with_live_chat_flag_but_no_path ?? 0
        ),
        total_media_with_live_chat_path_but_not_live: Number(
            rows[0]?.total_media_with_live_chat_path_but_not_live ?? 0
        ),
    };
}

export async function listMediaIntegrityReferences(): Promise<MediaIntegrityReference[]> {
    const db = await getDb();

    return db.select<MediaIntegrityReference[]>(
        `SELECT
            id,
            title,
            file_path,
            thumbnail_path,
            live_chat_file_path
         FROM videos
         ORDER BY id ASC`
    );
}