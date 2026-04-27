import type { MediaRow } from "../../types/media";

type CreateMediaOverrides = Partial<MediaRow>;

export function createMedia(overrides: CreateMediaOverrides = {}): MediaRow {
    const media: MediaRow = {
        id: 1,
        channel_id: 10,
        title: "Media 1",
        file_path: "media/item-1.mp4",
        thumbnail_path: null,
        media_type: "video",
        youtube_video_id: null,
        watched_at: null,
        published_at: null,
        duration_seconds: null,
        progress_seconds: 0,
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        created_at: "2026-03-29T10:00:00.000Z",
    };

    return {
        ...media,
        ...overrides,
        duration_seconds: overrides.duration_seconds ?? media.duration_seconds,
        progress_seconds: overrides.progress_seconds ?? media.progress_seconds,
        has_comments: overrides.has_comments ?? media.has_comments,
        comments_count: overrides.comments_count ?? media.comments_count,
        is_live: overrides.is_live ?? media.is_live,
        has_live_chat: overrides.has_live_chat ?? media.has_live_chat,
        live_chat_file_path: overrides.live_chat_file_path ?? media.live_chat_file_path,
    };
}