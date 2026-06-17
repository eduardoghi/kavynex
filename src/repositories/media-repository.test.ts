import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbModule from "../lib/db";
import { createTestDb, type TestDatabase } from "../test/helpers/create-test-db";
import {
    countMediaUsingFilePathOutsideMedia,
    countMediaUsingThumbnailOutsideMedia,
    deleteMediaById,
    findMediaByChannelAndFilePath,
    getMediaRepositoryStats,
    insertMedia,
    listMediaByChannel,
    listMediaCommentsByMediaId,
    listMediaIntegrityReferences,
    markMediaAsUnwatched,
    markMediaAsWatched,
    replaceMediaComments,
    updateMediaProgress,
    updateMediaTitle,
} from "./media-repository";
import { insertChannel } from "./channel-repository";
import type { YtDlpComment } from "../types/media";

vi.mock("../lib/db");

let closeDb: () => void;
let testDb: TestDatabase;
let channelId: number;

beforeEach(async () => {
    const { db, close } = createTestDb();
    testDb = db;
    closeDb = close;
    vi.mocked(dbModule.getDb).mockResolvedValue(db as any);
    channelId = (await insertChannel("Test Channel", "@testchannel", null))!;
});

afterEach(() => {
    closeDb();
});

async function seedMedia(
    filePath = "video/a.mp4",
    opts: { thumb?: string | null; isLive?: boolean; liveChatFilePath?: string | null } = {}
) {
    return insertMedia(
        channelId,
        "Test video",
        filePath,
        opts.thumb ?? null,
        "video",
        null,
        null,
        null,
        opts.isLive ?? false,
        opts.liveChatFilePath ?? null
    );
}

describe("insertMedia", () => {
    it("returns a positive numeric id", async () => {
        const id = await seedMedia();
        expect(typeof id).toBe("number");
        expect(id).toBeGreaterThan(0);
    });

    it("stores is_live and has_live_chat flags correctly", async () => {
        await seedMedia("video/live.mp4", { isLive: true, liveChatFilePath: "chat/live.json" });
        const media = await findMediaByChannelAndFilePath(channelId, "video/live.mp4");
        expect(media!.is_live).toBe(1);
        expect(media!.has_live_chat).toBe(1);
        expect(media!.live_chat_file_path).toBe("chat/live.json");
    });

    it("defaults progress_seconds and comment flags to 0", async () => {
        const id = await seedMedia();
        const media = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(media!.progress_seconds).toBe(0);
        expect(media!.has_comments).toBe(0);
        expect(media!.comments_count).toBe(0);
    });

    it("returns the existing id without creating a duplicate when the same file is inserted twice", async () => {
        const id1 = await seedMedia("video/dup.mp4");
        const id2 = await seedMedia("video/dup.mp4");

        expect(id1).toBe(id2);

        const rows = await listMediaByChannel(channelId);
        expect(rows.filter((r) => r.file_path === "video/dup.mp4")).toHaveLength(1);
    });

    it("does not ignore validation errors for invalid media rows", async () => {
        await expect(
            insertMedia(channelId, "   ", "video/invalid.mp4", null, "video", null, null, null, false, null)
        ).rejects.toThrow();
    });
});

describe("findMediaByChannelAndFilePath", () => {
    it("returns the matching media row with all fields", async () => {
        await seedMedia("video/a.mp4", { thumb: "thumb/a.jpg" });
        const media = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(media).toMatchObject({
            channel_id: channelId,
            title: "Test video",
            file_path: "video/a.mp4",
            thumbnail_path: "thumb/a.jpg",
            media_type: "video",
        });
    });

    it("returns null when not found", async () => {
        expect(await findMediaByChannelAndFilePath(channelId, "video/missing.mp4")).toBeNull();
    });
});

describe("listMediaByChannel", () => {
    it("returns only media belonging to the given channel", async () => {
        const otherId = (await insertChannel("Other", "@other", null))!;
        await seedMedia("video/mine.mp4");
        await insertMedia(otherId, "Other", "video/theirs.mp4", null, "video", null, null, null, false, null);
        const rows = await listMediaByChannel(channelId);
        expect(rows).toHaveLength(1);
        expect(rows[0].file_path).toBe("video/mine.mp4");
    });

    it("orders by id desc when created_at is equal", async () => {
        await seedMedia("video/a.mp4");
        await seedMedia("video/b.mp4");
        const rows = await listMediaByChannel(channelId);
        expect(rows[0].file_path).toBe("video/b.mp4");
        expect(rows[1].file_path).toBe("video/a.mp4");
    });

    it("returns empty array when channel has no media", async () => {
        expect(await listMediaByChannel(channelId)).toEqual([]);
    });
});

describe("markMediaAsWatched and markMediaAsUnwatched", () => {
    it("sets watched_at then clears it", async () => {
        const id = (await seedMedia())!;
        await markMediaAsWatched(id);
        const watched = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(watched!.watched_at).not.toBeNull();

        await markMediaAsUnwatched(id);
        const unwatched = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(unwatched!.watched_at).toBeNull();
    });

    it("resets progress_seconds to 0 when marking as watched", async () => {
        const id = (await seedMedia())!;
        await updateMediaProgress(id, 42);
        await markMediaAsWatched(id);
        const media = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(media!.progress_seconds).toBe(0);
    });
});

describe("updateMediaProgress", () => {
    it("updates progress when media is unwatched", async () => {
        const id = (await seedMedia())!;
        await updateMediaProgress(id, 42);
        const media = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(media!.progress_seconds).toBe(42);
    });

    it("does not update progress when media is already watched", async () => {
        const id = (await seedMedia())!;
        await markMediaAsWatched(id);
        await updateMediaProgress(id, 99);
        const media = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(media!.progress_seconds).toBe(0);
    });
});

describe("updateMediaTitle", () => {
    it("changes the title", async () => {
        const id = (await seedMedia())!;
        await updateMediaTitle(id, "Updated title");
        const media = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(media!.title).toBe("Updated title");
    });
});

describe("deleteMediaById", () => {
    it("removes the media row", async () => {
        const id = (await seedMedia())!;
        await deleteMediaById(id);
        expect(await findMediaByChannelAndFilePath(channelId, "video/a.mp4")).toBeNull();
    });
});

describe("countMediaUsingThumbnailOutsideMedia", () => {
    it("counts other media rows using the same thumbnail", async () => {
        const id1 = (await seedMedia("video/a.mp4", { thumb: "shared.jpg" }))!;
        const id2 = (await seedMedia("video/b.mp4", { thumb: "shared.jpg" }))!;
        expect(await countMediaUsingThumbnailOutsideMedia("shared.jpg", id1)).toBe(1);
        expect(await countMediaUsingThumbnailOutsideMedia("shared.jpg", id2)).toBe(1);
    });

    it("returns 0 when only the given media uses the thumbnail", async () => {
        const id = (await seedMedia("video/a.mp4", { thumb: "unique.jpg" }))!;
        expect(await countMediaUsingThumbnailOutsideMedia("unique.jpg", id)).toBe(0);
    });
});

describe("countMediaUsingFilePathOutsideMedia", () => {
    it("counts other media rows with the same file path", async () => {
        const otherId = (await insertChannel("Other", "@other", null))!;
        const id1 = (await insertMedia(channelId, "V1", "video/shared.mp4", null, "video", null, null, null, false, null))!;
        await insertMedia(otherId, "V2", "video/shared.mp4", null, "video", null, null, null, false, null);
        expect(await countMediaUsingFilePathOutsideMedia("video/shared.mp4", id1)).toBe(1);
    });

    it("returns 0 when only the given media uses the file path", async () => {
        const id = (await seedMedia("video/unique.mp4"))!;
        expect(await countMediaUsingFilePathOutsideMedia("video/unique.mp4", id)).toBe(0);
    });
});

const SAMPLE_COMMENT: YtDlpComment = {
    comment_id: "c1",
    parent_comment_id: null,
    author_name: "Alice",
    author_handle: "@alice",
    author_channel_id: null,
    author_thumbnail: null,
    text: "Great video!",
    like_count: 5,
    reply_count: 1,
    is_author_uploader: false,
    is_favorited: false,
    is_pinned: true,
    is_edited: false,
    time_text: "1 day ago",
    published_at: "2026-01-01",
};

describe("replaceMediaComments", () => {
    it("inserts non-blank comments and updates video flags", async () => {
        const blankComment: YtDlpComment = { ...SAMPLE_COMMENT, comment_id: "c2", text: "   " };
        const id = (await seedMedia())!;
        await replaceMediaComments(id, [SAMPLE_COMMENT, blankComment]);

        const rows = await listMediaCommentsByMediaId(id);
        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe("Great video!");
        expect(rows[0].is_pinned).toBe(1);

        const media = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(media!.has_comments).toBe(1);
        expect(media!.comments_count).toBe(1);
    });

    it("replaces all comments on a second call", async () => {
        const id = (await seedMedia())!;
        await replaceMediaComments(id, [SAMPLE_COMMENT]);
        await replaceMediaComments(id, [{ ...SAMPLE_COMMENT, comment_id: "c3", text: "Replaced" }]);
        const rows = await listMediaCommentsByMediaId(id);
        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe("Replaced");
    });

    it("clears comments and resets video flags when called with empty array", async () => {
        const id = (await seedMedia())!;
        await replaceMediaComments(id, [SAMPLE_COMMENT]);
        await replaceMediaComments(id, []);
        expect(await listMediaCommentsByMediaId(id)).toHaveLength(0);
        const media = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(media!.has_comments).toBe(0);
        expect(media!.comments_count).toBe(0);
    });

    it("rolls back and preserves original comments when an INSERT fails mid-loop", async () => {
        const id = (await seedMedia())!;
        await replaceMediaComments(id, [SAMPLE_COMMENT]);

        // Wrap execute to throw on INSERT while letting BEGIN/DELETE/ROLLBACK pass through
        const originalExecute = testDb.execute.bind(testDb);
        vi.mocked(dbModule.getDb).mockResolvedValue({
            ...testDb,
            execute: async (sql: string, values?: unknown[]) => {
                if (sql.trim().toUpperCase().startsWith("INSERT")) {
                    throw new Error("Simulated INSERT failure");
                }
                return originalExecute(sql, values);
            },
        } as any);

        await expect(
            replaceMediaComments(id, [{ ...SAMPLE_COMMENT, comment_id: "c_new", text: "New comment" }])
        ).rejects.toThrow("Simulated INSERT failure");

        // Restore real db and confirm original state survived the rollback
        vi.mocked(dbModule.getDb).mockResolvedValue(testDb as any);

        const rows = await listMediaCommentsByMediaId(id);
        expect(rows).toHaveLength(1);
        expect(rows[0].text).toBe("Great video!");

        const media = await findMediaByChannelAndFilePath(channelId, "video/a.mp4");
        expect(media!.has_comments).toBe(1);
        expect(media!.comments_count).toBe(1);
    });
});

describe("getMediaRepositoryStats", () => {
    it("returns zero counts for an empty db", async () => {
        const stats = await getMediaRepositoryStats();
        expect(stats.total_media).toBe(0);
        expect(stats.total_video_media).toBe(0);
        expect(stats.total_audio_media).toBe(0);
    });

    it("counts media by type, thumbnail, watched status, and live flags", async () => {
        await insertMedia(channelId, "V1", "video/a.mp4", "thumb/a.jpg", "video", null, null, null, false, null);
        await insertMedia(channelId, "V2", "video/b.mp4", null, "audio", null, null, null, false, null);
        const id3 = (await insertMedia(channelId, "V3", "video/c.mp4", null, "video", null, null, null, true, "chat/c.json"))!;
        await markMediaAsWatched(id3);

        const stats = await getMediaRepositoryStats();
        expect(stats.total_media).toBe(3);
        expect(stats.total_video_media).toBe(2);
        expect(stats.total_audio_media).toBe(1);
        expect(stats.total_with_thumbnail).toBe(1);
        expect(stats.total_without_thumbnail).toBe(2);
        expect(stats.total_watched).toBe(1);
        expect(stats.total_unwatched).toBe(2);
        expect(stats.total_live_media).toBe(1);
        expect(stats.total_with_live_chat).toBe(1);
        expect(stats.total_without_live_chat).toBe(2);
        expect(stats.total_media_with_live_chat_flag_but_no_path).toBe(0);
        expect(stats.total_media_with_live_chat_path_but_not_live).toBe(0);
    });

    it("detects anomaly: has_live_chat flag set but live_chat_file_path is null", async () => {
        const id = (await seedMedia("video/a.mp4"))!;
        await testDb.execute(
            "UPDATE videos SET has_live_chat = 1, live_chat_file_path = NULL WHERE id = ?",
            [id]
        );
        const stats = await getMediaRepositoryStats();
        expect(stats.total_media_with_live_chat_flag_but_no_path).toBe(1);
    });

    it("detects anomaly: live_chat_file_path set but is_live is 0", async () => {
        const id = (await seedMedia("video/a.mp4"))!;
        await testDb.execute(
            "UPDATE videos SET is_live = 0, live_chat_file_path = 'chat/a.json' WHERE id = ?",
            [id]
        );
        const stats = await getMediaRepositoryStats();
        expect(stats.total_media_with_live_chat_path_but_not_live).toBe(1);
    });
});

describe("listMediaIntegrityReferences", () => {
    it("returns id, title, file_path, thumbnail_path and live_chat_file_path ordered by id", async () => {
        await seedMedia("video/a.mp4", { thumb: "thumb/a.jpg" });
        await seedMedia("video/b.mp4");
        const refs = await listMediaIntegrityReferences();
        expect(refs).toHaveLength(2);
        expect(refs[0]).toMatchObject({ file_path: "video/a.mp4", thumbnail_path: "thumb/a.jpg" });
        expect(refs[1]).toMatchObject({ file_path: "video/b.mp4", thumbnail_path: null });
    });

    it("returns empty array when no media exists", async () => {
        expect(await listMediaIntegrityReferences()).toEqual([]);
    });
});
