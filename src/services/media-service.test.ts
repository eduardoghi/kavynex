import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    createMedia,
    deleteMediaWithFileCleanup,
    listChannelMedia,
    refreshMediaComments,
    saveMediaProgress,
    setMediaUnwatched,
    setMediaWatched,
} from "./media-service";

vi.mock("../repositories", () => ({
    countMediaUsingFilePathOutsideMedia: vi.fn(),
    countMediaUsingThumbnailOutsideMedia: vi.fn(),
    deleteMediaById: vi.fn(),
    findMediaByChannelAndFilePath: vi.fn(),
    insertMedia: vi.fn(),
    listMediaByChannel: vi.fn(),
    listMediaCommentsByMediaId: vi.fn(),
    markMediaAsUnwatched: vi.fn(),
    markMediaAsWatched: vi.fn(),
    updateMediaProgress: vi.fn(),
}));

vi.mock("./media-artifacts-service", () => ({
    cleanupCreatedArtifacts: vi.fn(),
    prepareLocalArtifacts: vi.fn(),
    prepareYtDlpArtifacts: vi.fn(),
}));

vi.mock("./media-input-service", () => ({
    normalizeDeleteMediaInput: vi.fn(),
    validateChannelId: vi.fn(),
    validateCreateMediaInput: vi.fn(),
    validateMediaId: vi.fn(),
}));

vi.mock("./media-file-service", () => ({
    deleteMediaFile: vi.fn(),
}));

vi.mock("./thumbnail-service", () => ({
    deleteThumbnailFile: vi.fn(),
}));

vi.mock("./media-metadata-service", () => ({
    readMediaDurationInSeconds: vi.fn(),
}));

vi.mock("./media-download-service", () => ({
    fetchYouTubeComments: vi.fn(),
}));

vi.mock("./media-comments-service", () => ({
    replaceMediaCommentsInBackend: vi.fn(),
}));

vi.mock("./live-chat-service", () => ({
    deleteLiveChatFileFromAppData: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import {
    countMediaUsingFilePathOutsideMedia,
    countMediaUsingThumbnailOutsideMedia,
    deleteMediaById,
    findMediaByChannelAndFilePath,
    insertMedia,
    listMediaByChannel,
    markMediaAsUnwatched,
    markMediaAsWatched,
    updateMediaProgress,
} from "../repositories";
import {
    cleanupCreatedArtifacts,
    prepareLocalArtifacts,
    prepareYtDlpArtifacts,
} from "./media-artifacts-service";
import {
    normalizeDeleteMediaInput,
    validateChannelId,
    validateCreateMediaInput,
    validateMediaId,
} from "./media-input-service";
import { deleteMediaFile } from "./media-file-service";
import { readMediaDurationInSeconds } from "./media-metadata-service";
import { deleteThumbnailFile } from "./thumbnail-service";
import { deleteLiveChatFileFromAppData } from "./live-chat-service";
import { fetchYouTubeComments } from "./media-download-service";
import { replaceMediaCommentsInBackend } from "./media-comments-service";
import { logError } from "../utils/app-logger";

describe("media-service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("lists channel media after validating channel id", async () => {
        vi.mocked(validateChannelId).mockImplementationOnce(() => {});
        vi.mocked(listMediaByChannel).mockResolvedValueOnce([
            {
                id: 1,
                channel_id: 10,
                title: "Video A",
                file_path: "video/a.mp4",
                thumbnail_path: null,
                media_type: "video",
                youtube_video_id: null,
                watched_at: null,
                published_at: null,
                duration_seconds: 125,
                progress_seconds: 0,
                has_comments: 0,
                comments_count: 0,
                is_live: 0,
                has_live_chat: 0,
                live_chat_file_path: null,
                created_at: "2026-03-31T10:00:00.000Z",
            },
        ]);

        const result = await listChannelMedia(10);

        expect(validateChannelId).toHaveBeenCalledWith(10);
        expect(listMediaByChannel).toHaveBeenCalledWith(10);
        expect(result).toHaveLength(1);
    });

    it("creates local media successfully", async () => {
        const normalizedInput = {
            channelId: 10,
            title: "Video A",
            sourceMode: "local" as const,
            sourceValue: "/tmp/a.mp4",
            thumbnailSourcePath: null,
            mediaType: "video" as const,
            importMode: "copy" as const,
            libraryPath: "/library",
            publishedAt: "2026-03-31",
            ytDlpRunId: "",
            ytDlpFormatId: "",
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
        };

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);

        vi.mocked(prepareLocalArtifacts).mockResolvedValueOnce({
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            youtubeVideoId: null,
            publishedAt: "2026-03-31",
            mediaType: "video",
            isLive: false,
            liveChatFilePath: null,
        });

        vi.mocked(findMediaByChannelAndFilePath).mockResolvedValueOnce(null);
        vi.mocked(readMediaDurationInSeconds).mockResolvedValueOnce(125);
        vi.mocked(insertMedia).mockResolvedValueOnce(55);

        const result = await createMedia(normalizedInput);

        expect(validateCreateMediaInput).toHaveBeenCalledWith(normalizedInput);
        expect(prepareLocalArtifacts).toHaveBeenCalledWith({
            sourceValue: "/tmp/a.mp4",
            thumbnailSourcePath: null,
            mediaType: "video",
            importMode: "copy",
            libraryPath: "/library",
            publishedAt: "2026-03-31",
        });
        expect(findMediaByChannelAndFilePath).toHaveBeenCalledWith(10, "video/a.mp4");
        expect(readMediaDurationInSeconds).toHaveBeenCalledWith(
            "video/a.mp4",
            "/library",
            "video"
        );
        expect(insertMedia).toHaveBeenCalledWith(
            10,
            "Video A",
            "video/a.mp4",
            "thumbnails/a.jpg",
            "video",
            null,
            "2026-03-31",
            125,
            false,
            null
        );
        expect(result).toEqual({ id: 55 });
    });

    it("creates yt-dlp media successfully", async () => {
        const normalizedInput = {
            channelId: 10,
            title: "Video A",
            sourceMode: "yt-dlp" as const,
            sourceValue: "https://youtube.com/watch?v=abc",
            thumbnailSourcePath: null,
            mediaType: "video" as const,
            importMode: "copy" as const,
            libraryPath: "/library",
            publishedAt: null,
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137",
            downloadComments: false,
            downloadLiveChat: true,
            cookiesBrowser: "edge",
        };

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);

        vi.mocked(prepareYtDlpArtifacts).mockResolvedValueOnce({
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            youtubeVideoId: "abc",
            publishedAt: "2026-03-31",
            mediaType: "video",
            isLive: true,
            liveChatFilePath: "live-chat/abc.json",
        });

        vi.mocked(findMediaByChannelAndFilePath).mockResolvedValueOnce(null);
        vi.mocked(readMediaDurationInSeconds).mockResolvedValueOnce(242);
        vi.mocked(insertMedia).mockResolvedValueOnce(77);

        const result = await createMedia(normalizedInput);

        expect(prepareYtDlpArtifacts).toHaveBeenCalledWith({
            sourceValue: "https://youtube.com/watch?v=abc",
            thumbnailSourcePath: null,
            libraryPath: "/library",
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137",
            cookiesBrowser: "edge",
            downloadLiveChat: true,
        });
        expect(readMediaDurationInSeconds).toHaveBeenCalledWith(
            "video/a.mp4",
            "/library",
            "video"
        );
        expect(insertMedia).toHaveBeenCalledWith(
            10,
            "Video A",
            "video/a.mp4",
            "thumbnails/a.jpg",
            "video",
            "abc",
            "2026-03-31",
            242,
            true,
            "live-chat/abc.json"
        );
        expect(result).toEqual({ id: 77 });
    });

    it("persists fetched comments through the backend when adding yt-dlp media", async () => {
        const normalizedInput = {
            channelId: 10,
            title: "Video A",
            sourceMode: "yt-dlp" as const,
            sourceValue: "https://youtube.com/watch?v=abc",
            thumbnailSourcePath: null,
            mediaType: "video" as const,
            importMode: "copy" as const,
            libraryPath: "/library",
            publishedAt: null,
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137",
            downloadComments: true,
            downloadLiveChat: false,
            cookiesBrowser: "edge",
        };

        const fetchedComment = {
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

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);
        vi.mocked(prepareYtDlpArtifacts).mockResolvedValueOnce({
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            youtubeVideoId: "abc",
            publishedAt: "2026-03-31",
            mediaType: "video",
            isLive: false,
            liveChatFilePath: null,
        });
        vi.mocked(findMediaByChannelAndFilePath).mockResolvedValueOnce(null);
        vi.mocked(readMediaDurationInSeconds).mockResolvedValueOnce(242);
        vi.mocked(insertMedia).mockResolvedValueOnce(77);
        vi.mocked(fetchYouTubeComments).mockResolvedValueOnce([fetchedComment]);
        vi.mocked(replaceMediaCommentsInBackend).mockResolvedValueOnce(1);

        await createMedia(normalizedInput);

        expect(fetchYouTubeComments).toHaveBeenCalledWith("abc", "edge");
        expect(replaceMediaCommentsInBackend).toHaveBeenCalledWith(77, [fetchedComment]);
    });

    it("cleans created artifacts when insertMedia rejects before registration", async () => {
        const normalizedInput = {
            channelId: 10,
            title: "Video A",
            sourceMode: "local" as const,
            sourceValue: "/tmp/a.mp4",
            thumbnailSourcePath: null,
            mediaType: "video" as const,
            importMode: "copy" as const,
            libraryPath: "/library",
            publishedAt: null,
            ytDlpRunId: "",
            ytDlpFormatId: "",
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
        };

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);

        vi.mocked(prepareLocalArtifacts).mockResolvedValueOnce({
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            youtubeVideoId: null,
            publishedAt: null,
            mediaType: "video",
            isLive: false,
            liveChatFilePath: null,
        });

        vi.mocked(findMediaByChannelAndFilePath).mockRejectedValueOnce(new Error("db failed"));
        vi.mocked(cleanupCreatedArtifacts).mockResolvedValueOnce(undefined);

        await expect(createMedia(normalizedInput)).rejects.toThrow("db failed");

        expect(cleanupCreatedArtifacts).toHaveBeenCalledWith(
            "video/a.mp4",
            "thumbnails/a.jpg",
            "/library"
        );
    });

    it("cleans live chat file when insertMedia rejects before registration", async () => {
        const normalizedInput = {
            channelId: 10,
            title: "Video A",
            sourceMode: "yt-dlp" as const,
            sourceValue: "https://youtube.com/watch?v=abc",
            thumbnailSourcePath: null,
            mediaType: "video" as const,
            importMode: "copy" as const,
            libraryPath: "/library",
            publishedAt: null,
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137",
            downloadComments: false,
            downloadLiveChat: true,
            cookiesBrowser: null,
        };

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);

        vi.mocked(prepareYtDlpArtifacts).mockResolvedValueOnce({
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            youtubeVideoId: "abc",
            publishedAt: null,
            mediaType: "video",
            isLive: true,
            liveChatFilePath: "live-chat/abc.json",
        });

        vi.mocked(findMediaByChannelAndFilePath).mockResolvedValueOnce(null);
        vi.mocked(readMediaDurationInSeconds).mockResolvedValueOnce(100);
        vi.mocked(insertMedia).mockRejectedValueOnce(new Error("db constraint"));
        vi.mocked(cleanupCreatedArtifacts).mockResolvedValueOnce(undefined);
        vi.mocked(deleteLiveChatFileFromAppData).mockResolvedValueOnce(undefined);

        await expect(createMedia(normalizedInput)).rejects.toThrow("db constraint");

        expect(cleanupCreatedArtifacts).toHaveBeenCalledWith(
            "video/a.mp4",
            "thumbnails/a.jpg",
            "/library"
        );
        expect(deleteLiveChatFileFromAppData).toHaveBeenCalledWith("live-chat/abc.json");
    });

    it("does not clean artifacts when error occurs after successful insertMedia", async () => {
        const normalizedInput = {
            channelId: 10,
            title: "Video A",
            sourceMode: "yt-dlp" as const,
            sourceValue: "https://youtube.com/watch?v=abc",
            thumbnailSourcePath: null,
            mediaType: "video" as const,
            importMode: "copy" as const,
            libraryPath: "/library",
            publishedAt: null,
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137",
            downloadComments: false,
            downloadLiveChat: true,
            cookiesBrowser: null,
        };

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);

        vi.mocked(prepareYtDlpArtifacts).mockResolvedValueOnce({
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            youtubeVideoId: "abc",
            publishedAt: null,
            mediaType: "video",
            isLive: true,
            liveChatFilePath: "live-chat/abc.json",
        });

        vi.mocked(findMediaByChannelAndFilePath).mockResolvedValueOnce(null);
        vi.mocked(readMediaDurationInSeconds).mockResolvedValueOnce(100);
        vi.mocked(insertMedia).mockResolvedValueOnce(42);

        // first onProgress call is before insertMedia - must resolve so insertMedia runs
        // second call is after insertMedia succeeds (mediaRegistered = true) - then rejects
        const failingOnProgress = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("progress failed"));

        await expect(createMedia(normalizedInput, { onProgress: failingOnProgress })).rejects.toThrow(
            "progress failed"
        );

        expect(cleanupCreatedArtifacts).not.toHaveBeenCalled();
        expect(deleteLiveChatFileFromAppData).not.toHaveBeenCalled();
    });

    it("rejects duplicate media for channel", async () => {
        const normalizedInput = {
            channelId: 10,
            title: "Video A",
            sourceMode: "local" as const,
            sourceValue: "/tmp/a.mp4",
            thumbnailSourcePath: null,
            mediaType: "video" as const,
            importMode: "copy" as const,
            libraryPath: "/library",
            publishedAt: null,
            ytDlpRunId: "",
            ytDlpFormatId: "",
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
        };

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);

        vi.mocked(prepareLocalArtifacts).mockResolvedValueOnce({
            filePath: "video/a.mp4",
            thumbnailPath: null,
            youtubeVideoId: null,
            publishedAt: null,
            mediaType: "video",
            isLive: false,
            liveChatFilePath: null,
        });

        vi.mocked(findMediaByChannelAndFilePath).mockResolvedValueOnce({
            id: 1,
            channel_id: 10,
            title: "Video A",
            file_path: "video/a.mp4",
            thumbnail_path: null,
            media_type: "video",
            youtube_video_id: null,
            watched_at: null,
            published_at: null,
            duration_seconds: 125,
            progress_seconds: 0,
            has_comments: 0,
            comments_count: 0,
            is_live: 0,
            has_live_chat: 0,
            live_chat_file_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        });

        await expect(createMedia(normalizedInput)).rejects.toThrow(
            "This media is already registered for the selected channel."
        );

        expect(insertMedia).not.toHaveBeenCalled();
    });

    it("deletes media and removes unused file and thumbnail", async () => {
        vi.mocked(normalizeDeleteMediaInput).mockReturnValueOnce({
            mediaId: 10,
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            libraryPath: "/library",
        });

        vi.mocked(deleteMediaById).mockResolvedValueOnce(undefined);
        vi.mocked(countMediaUsingFilePathOutsideMedia).mockResolvedValueOnce(0);
        vi.mocked(countMediaUsingThumbnailOutsideMedia).mockResolvedValueOnce(0);
        vi.mocked(deleteMediaFile).mockResolvedValueOnce(undefined);
        vi.mocked(deleteThumbnailFile).mockResolvedValueOnce(undefined);

        await deleteMediaWithFileCleanup(10, "video/a.mp4", "thumbnails/a.jpg", "/library");

        expect(deleteMediaById).toHaveBeenCalledWith(10);
        expect(deleteMediaFile).toHaveBeenCalledWith("video/a.mp4", "/library");
        expect(deleteThumbnailFile).toHaveBeenCalledWith("thumbnails/a.jpg", "/library");
    });

    it("does not remove file/thumbnail when still used elsewhere", async () => {
        vi.mocked(normalizeDeleteMediaInput).mockReturnValueOnce({
            mediaId: 10,
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            libraryPath: "/library",
        });

        vi.mocked(deleteMediaById).mockResolvedValueOnce(undefined);
        vi.mocked(countMediaUsingFilePathOutsideMedia).mockResolvedValueOnce(2);
        vi.mocked(countMediaUsingThumbnailOutsideMedia).mockResolvedValueOnce(3);

        await deleteMediaWithFileCleanup(10, "video/a.mp4", "thumbnails/a.jpg", "/library");

        expect(deleteMediaFile).not.toHaveBeenCalled();
        expect(deleteThumbnailFile).not.toHaveBeenCalled();
    });

    it("does not throw and logs an orphan warning when file cleanup fails after the row is deleted", async () => {
        vi.mocked(normalizeDeleteMediaInput).mockReturnValueOnce({
            mediaId: 10,
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            libraryPath: "/library",
        });

        vi.mocked(deleteMediaById).mockResolvedValueOnce(undefined);
        vi.mocked(countMediaUsingFilePathOutsideMedia).mockResolvedValueOnce(0);
        vi.mocked(countMediaUsingThumbnailOutsideMedia).mockResolvedValueOnce(0);
        vi.mocked(deleteMediaFile).mockRejectedValueOnce(new Error("disk error"));
        vi.mocked(deleteThumbnailFile).mockResolvedValueOnce(undefined);

        await expect(
            deleteMediaWithFileCleanup(10, "video/a.mp4", "thumbnails/a.jpg", "/library")
        ).resolves.toBeUndefined();

        expect(deleteMediaById).toHaveBeenCalledWith(10);
        expect(logError).toHaveBeenCalledWith(
            "media-service",
            expect.stringContaining("orphaned"),
            expect.any(Error),
            expect.objectContaining({ mediaId: 10, path: "video/a.mp4" })
        );
    });

    it("marks media as watched", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(markMediaAsWatched).mockResolvedValueOnce(undefined);

        await setMediaWatched(10);

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(markMediaAsWatched).toHaveBeenCalledWith(10);
    });

    it("refreshes comments through the backend", async () => {
        const fetchedComment = {
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

        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(fetchYouTubeComments).mockResolvedValueOnce([fetchedComment]);
        vi.mocked(replaceMediaCommentsInBackend).mockResolvedValueOnce(1);

        const result = await refreshMediaComments(10, "abc", "edge");

        expect(fetchYouTubeComments).toHaveBeenCalledWith("abc", "edge");
        expect(replaceMediaCommentsInBackend).toHaveBeenCalledWith(10, [fetchedComment]);
        expect(result).toEqual({ updated: true, totalComments: 1 });
    });

    it("marks media as unwatched", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(markMediaAsUnwatched).mockResolvedValueOnce(undefined);

        await setMediaUnwatched(10);

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(markMediaAsUnwatched).toHaveBeenCalledWith(10);
    });

    it("saves media progress with sanitized integer value", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(updateMediaProgress).mockResolvedValueOnce(undefined);

        await saveMediaProgress(10, 42.9);

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(updateMediaProgress).toHaveBeenCalledWith(10, 42);
    });

    it("saves media progress with minimum zero", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(updateMediaProgress).mockResolvedValueOnce(undefined);

        await saveMediaProgress(10, -15);

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(updateMediaProgress).toHaveBeenCalledWith(10, 0);
    });
});
