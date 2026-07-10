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
    deleteMediaWithArtifacts: vi.fn(),
    findMediaByChannelAndFilePath: vi.fn(),
    insertMedia: vi.fn(),
    listMediaByChannel: vi.fn(),
    listMediaCommentsByMediaId: vi.fn(),
    markMediaAsUnwatched: vi.fn(),
    markMediaAsWatched: vi.fn(),
    mediaExistsForChannelAndYoutubeId: vi.fn(),
    updateMediaProgress: vi.fn(),
}));

vi.mock("./media-artifacts-service", () => ({
    cleanupCreatedArtifacts: vi.fn(),
    prepareLocalArtifacts: vi.fn(),
    prepareYtDlpArtifacts: vi.fn(),
}));

vi.mock("./media-input-service", () => ({
    validateChannelId: vi.fn(),
    validateCreateMediaInput: vi.fn(),
    validateMediaId: vi.fn(),
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

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import {
    deleteMediaWithArtifacts,
    findMediaByChannelAndFilePath,
    insertMedia,
    listMediaByChannel,
    markMediaAsUnwatched,
    markMediaAsWatched,
    mediaExistsForChannelAndYoutubeId,
    updateMediaProgress,
} from "../repositories";
import {
    cleanupCreatedArtifacts,
    prepareLocalArtifacts,
    prepareYtDlpArtifacts,
} from "./media-artifacts-service";
import {
    validateChannelId,
    validateCreateMediaInput,
    validateMediaId,
} from "./media-input-service";
import { readMediaDurationInSeconds } from "./media-metadata-service";
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
            ytDlpYoutubeVideoId: null,
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
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
            ytDlpYoutubeVideoId: null,
            downloadComments: false,
            downloadLiveChat: true,
            cookiesBrowser: "edge",
            cookiesPath: null,
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
            cookiesPath: null,
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

    it("checks for a yt-dlp duplicate by the resolved youtube video id and proceeds when none exists", async () => {
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
            ytDlpYoutubeVideoId: "abc",
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
        };

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);
        vi.mocked(mediaExistsForChannelAndYoutubeId).mockResolvedValueOnce(false);
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
        vi.mocked(insertMedia).mockResolvedValueOnce(78);

        const result = await createMedia(normalizedInput);

        expect(mediaExistsForChannelAndYoutubeId).toHaveBeenCalledWith(10, "abc");
        expect(prepareYtDlpArtifacts).toHaveBeenCalled();
        expect(insertMedia).toHaveBeenCalled();
        expect(result).toEqual({ id: 78 });
    });

    it("rejects a yt-dlp duplicate by the resolved youtube video id before downloading", async () => {
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
            ytDlpYoutubeVideoId: "abc",
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
        };

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);
        vi.mocked(mediaExistsForChannelAndYoutubeId).mockResolvedValueOnce(true);

        await expect(createMedia(normalizedInput)).rejects.toThrow(
            "This media is already registered for the selected channel."
        );

        expect(mediaExistsForChannelAndYoutubeId).toHaveBeenCalledWith(10, "abc");
        // The heavy yt-dlp download/artifact preparation must never run for an
        // already-registered video: this must fail fast, before wasting bandwidth/time.
        expect(prepareYtDlpArtifacts).not.toHaveBeenCalled();
        expect(insertMedia).not.toHaveBeenCalled();
    });

    it("skips the yt-dlp duplicate check when no youtube video id was resolved", async () => {
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
            ytDlpYoutubeVideoId: null,
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
        };

        vi.mocked(validateCreateMediaInput).mockReturnValueOnce(normalizedInput);
        vi.mocked(prepareYtDlpArtifacts).mockResolvedValueOnce({
            filePath: "video/a.mp4",
            thumbnailPath: "thumbnails/a.jpg",
            youtubeVideoId: null,
            publishedAt: null,
            mediaType: "video",
            isLive: false,
            liveChatFilePath: null,
        });
        vi.mocked(findMediaByChannelAndFilePath).mockResolvedValueOnce(null);
        vi.mocked(readMediaDurationInSeconds).mockResolvedValueOnce(100);
        vi.mocked(insertMedia).mockResolvedValueOnce(79);

        const result = await createMedia(normalizedInput);

        expect(mediaExistsForChannelAndYoutubeId).not.toHaveBeenCalled();
        expect(prepareYtDlpArtifacts).toHaveBeenCalled();
        expect(result).toEqual({ id: 79 });
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
            ytDlpYoutubeVideoId: null,
            downloadComments: true,
            downloadLiveChat: false,
            cookiesBrowser: "edge",
            cookiesPath: null,
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

        expect(fetchYouTubeComments).toHaveBeenCalledWith("abc", "edge", null);
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
            ytDlpYoutubeVideoId: null,
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
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
            null
        );
    });

    it("cleans every artifact through one call when insertMedia rejects before registration", async () => {
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
            ytDlpYoutubeVideoId: null,
            downloadComments: false,
            downloadLiveChat: true,
            cookiesBrowser: null,
            cookiesPath: null,
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

        await expect(createMedia(normalizedInput)).rejects.toThrow("db constraint");

        // The media file, thumbnail and live chat replay are all handed to the single
        // atomic backend cleanup; the "is the live chat still referenced" decision now lives
        // in the backend, not in a separate frontend reference-count call.
        expect(cleanupCreatedArtifacts).toHaveBeenCalledWith(
            "video/a.mp4",
            "thumbnails/a.jpg",
            "live-chat/abc.json"
        );
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
            ytDlpYoutubeVideoId: null,
            downloadComments: false,
            downloadLiveChat: true,
            cookiesBrowser: null,
            cookiesPath: null,
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
            ytDlpYoutubeVideoId: null,
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
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

    it("deletes media through the atomic backend command without logging when nothing failed", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(deleteMediaWithArtifacts).mockResolvedValueOnce({
            deleted_paths: ["video/a.mp4", "thumbnails/a.jpg"],
            skipped_shared_paths: [],
            failed_paths: [],
        });

        await expect(deleteMediaWithFileCleanup(10)).resolves.toBeUndefined();

        expect(validateMediaId).toHaveBeenCalledWith(10);
        expect(deleteMediaWithArtifacts).toHaveBeenCalledWith(10);
        expect(logError).not.toHaveBeenCalled();
    });

    it("logs an orphan warning when the backend reports files it could not delete", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(deleteMediaWithArtifacts).mockResolvedValueOnce({
            deleted_paths: [],
            skipped_shared_paths: [],
            failed_paths: ["video/a.mp4"],
        });

        await expect(deleteMediaWithFileCleanup(10)).resolves.toBeUndefined();

        expect(logError).toHaveBeenCalledWith(
            "media-service",
            expect.stringContaining("orphaned"),
            null,
            { mediaId: 10, failedPaths: ["video/a.mp4"] }
        );
    });

    it("rejects an invalid media id without calling the repository", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {
            throw new Error("Media id is invalid.");
        });

        await expect(deleteMediaWithFileCleanup(0)).rejects.toThrow("Media id is invalid.");

        expect(deleteMediaWithArtifacts).not.toHaveBeenCalled();
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

        expect(fetchYouTubeComments).toHaveBeenCalledWith("abc", "edge", null);
        expect(replaceMediaCommentsInBackend).toHaveBeenCalledWith(10, [fetchedComment]);
        expect(result).toEqual({ updated: true, totalComments: 1 });
    });

    it("reports no update and preserves saved comments when the refresh returns none", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(fetchYouTubeComments).mockResolvedValueOnce([]);

        const result = await refreshMediaComments(10, "abc", null);

        // A genuinely empty result is not an error and must not overwrite saved comments.
        expect(replaceMediaCommentsInBackend).not.toHaveBeenCalled();
        expect(result).toEqual({ updated: false, totalComments: 0 });
    });

    it("propagates a real fetch failure from refresh", async () => {
        vi.mocked(validateMediaId).mockImplementationOnce(() => {});
        vi.mocked(fetchYouTubeComments).mockRejectedValueOnce(new Error("extraction incomplete"));

        await expect(refreshMediaComments(10, "abc", null)).rejects.toThrow(
            "extraction incomplete"
        );
        expect(replaceMediaCommentsInBackend).not.toHaveBeenCalled();
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
