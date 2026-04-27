import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    cleanupCreatedArtifacts,
    prepareLocalArtifacts,
    prepareYtDlpArtifacts,
} from "./media-artifacts-service";

vi.mock("./media-download-service", () => ({
    downloadMediaFromUrl: vi.fn(),
}));

vi.mock("./media-file-service", () => ({
    deleteMediaFile: vi.fn(),
    importMediaFile: vi.fn(),
}));

vi.mock("./thumbnail-service", () => ({
    deleteTemporaryThumbnail: vi.fn(),
    deleteThumbnailFile: vi.fn(),
    downloadThumbnailFromUrl: vi.fn(),
    generateTemporaryThumbnail: vi.fn(),
    persistThumbnailFile: vi.fn(),
}));

import { downloadMediaFromUrl } from "./media-download-service";
import { deleteMediaFile, importMediaFile } from "./media-file-service";
import {
    deleteTemporaryThumbnail,
    deleteThumbnailFile,
    downloadThumbnailFromUrl,
    generateTemporaryThumbnail,
    persistThumbnailFile,
} from "./thumbnail-service";

describe("media-artifacts-service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("prepareYtDlpArtifacts", () => {
        it("prepares yt-dlp artifacts with downloaded thumbnail", async () => {
            vi.mocked(downloadMediaFromUrl).mockResolvedValue({
                file_path: "video/a.mp4",
                suggested_title: "Video A",
                youtube_video_id: "abc123",
                published_at: "2026-03-31",
                media_type: "video",
                thumbnail_path: null,
                thumbnail_url: "https://img.youtube.com/a.jpg",
                is_live: false,
                live_chat_file_path: null,
            });

            vi.mocked(downloadThumbnailFromUrl).mockResolvedValue("thumbnails/a.jpg");

            const result = await prepareYtDlpArtifacts({
                sourceValue: "https://youtube.com/watch?v=abc123",
                thumbnailSourcePath: null,
                libraryPath: "/library",
                ytDlpRunId: "run-1",
                ytDlpFormatId: "137",
                cookiesBrowser: null,
                downloadLiveChat: false,
            });

            expect(downloadMediaFromUrl).toHaveBeenCalledWith(
                "https://youtube.com/watch?v=abc123",
                "/library",
                "run-1",
                "137",
                null,
                null,
                false,
                false
            );

            expect(downloadThumbnailFromUrl).toHaveBeenCalledWith(
                "https://img.youtube.com/a.jpg",
                "/library"
            );

            expect(result).toEqual({
                filePath: "video/a.mp4",
                thumbnailPath: "thumbnails/a.jpg",
                youtubeVideoId: "abc123",
                publishedAt: "2026-03-31",
                mediaType: "video",
                isLive: false,
                liveChatFilePath: null,
            });
        });

        it("prefers explicit thumbnail source over metadata thumbnail url", async () => {
            vi.mocked(downloadMediaFromUrl).mockResolvedValue({
                file_path: "video/a.mp4",
                suggested_title: "Video A",
                youtube_video_id: "abc123",
                published_at: "2026-03-31",
                media_type: "video",
                thumbnail_path: null,
                thumbnail_url: "https://img.youtube.com/a.jpg",
                is_live: false,
                live_chat_file_path: null,
            });

            vi.mocked(downloadThumbnailFromUrl).mockResolvedValue("thumbnails/manual.jpg");

            await prepareYtDlpArtifacts({
                sourceValue: "https://youtube.com/watch?v=abc123",
                thumbnailSourcePath: "https://example.com/manual.jpg",
                libraryPath: "/library",
                ytDlpRunId: "run-1",
                ytDlpFormatId: "137",
                cookiesBrowser: null,
                downloadLiveChat: false,
            });

            expect(downloadMediaFromUrl).toHaveBeenCalledWith(
                "https://youtube.com/watch?v=abc123",
                "/library",
                "run-1",
                "137",
                null,
                null,
                false,
                true
            );

            expect(downloadThumbnailFromUrl).toHaveBeenCalledTimes(1);
            expect(downloadThumbnailFromUrl).toHaveBeenCalledWith(
                "https://example.com/manual.jpg",
                "/library"
            );
        });
    });

    describe("prepareLocalArtifacts", () => {
        it("prepares local artifacts using provided thumbnail", async () => {
            vi.mocked(importMediaFile).mockResolvedValue("video/a.mp4");
            vi.mocked(persistThumbnailFile).mockResolvedValue("thumbnails/a.jpg");

            const result = await prepareLocalArtifacts({
                sourceValue: "/tmp/a.mp4",
                thumbnailSourcePath: "/tmp/a.jpg",
                mediaType: "video",
                importMode: "copy",
                libraryPath: "/library",
                publishedAt: "2026-03-31",
            });

            expect(persistThumbnailFile).toHaveBeenCalledWith("/tmp/a.jpg", "/library");
            expect(importMediaFile).toHaveBeenCalledWith("/tmp/a.mp4", "copy", "/library");

            expect(result).toEqual({
                filePath: "video/a.mp4",
                thumbnailPath: "thumbnails/a.jpg",
                youtubeVideoId: null,
                publishedAt: "2026-03-31",
                mediaType: "video",
                isLive: false,
                liveChatFilePath: null,
            });
        });

        it("generates, persists and cleans temporary thumbnail when manual thumbnail is missing", async () => {
            vi.mocked(importMediaFile).mockResolvedValue("video/a.mp4");
            vi.mocked(generateTemporaryThumbnail).mockResolvedValue("/tmp/thumb-a.png");
            vi.mocked(persistThumbnailFile).mockResolvedValue("thumbnails/a.png");
            vi.mocked(deleteTemporaryThumbnail).mockResolvedValue(undefined);

            const result = await prepareLocalArtifacts({
                sourceValue: "/tmp/a.mp4",
                thumbnailSourcePath: null,
                mediaType: "video",
                importMode: "copy",
                libraryPath: "/library",
                publishedAt: null,
            });

            expect(generateTemporaryThumbnail).toHaveBeenCalledWith("/tmp/a.mp4");
            expect(persistThumbnailFile).toHaveBeenCalledWith("/tmp/thumb-a.png", "/library");
            expect(deleteTemporaryThumbnail).toHaveBeenCalledWith("/tmp/thumb-a.png");
            expect(importMediaFile).toHaveBeenCalledWith("/tmp/a.mp4", "copy", "/library");

            expect(result).toEqual({
                filePath: "video/a.mp4",
                thumbnailPath: "thumbnails/a.png",
                youtubeVideoId: null,
                publishedAt: null,
                mediaType: "video",
                isLive: false,
                liveChatFilePath: null,
            });
        });

        it("still cleans temporary thumbnail if persistence fails", async () => {
            vi.mocked(importMediaFile).mockResolvedValue("video/a.mp4");
            vi.mocked(generateTemporaryThumbnail).mockResolvedValue("/tmp/thumb-a.png");
            vi.mocked(persistThumbnailFile).mockRejectedValue(new Error("persist failed"));
            vi.mocked(deleteTemporaryThumbnail).mockResolvedValue(undefined);

            await expect(
                prepareLocalArtifacts({
                    sourceValue: "/tmp/a.mp4",
                    thumbnailSourcePath: null,
                    mediaType: "video",
                    importMode: "copy",
                    libraryPath: "/library",
                    publishedAt: null,
                })
            ).rejects.toThrow("persist failed");

            expect(deleteTemporaryThumbnail).toHaveBeenCalledWith("/tmp/thumb-a.png");
            expect(importMediaFile).not.toHaveBeenCalled();
        });
    });

    describe("cleanupCreatedArtifacts", () => {
        it("cleans both thumbnail and media file", async () => {
            vi.mocked(deleteThumbnailFile).mockResolvedValue(undefined);
            vi.mocked(deleteMediaFile).mockResolvedValue(undefined);

            await cleanupCreatedArtifacts("video/a.mp4", "thumbnails/a.jpg", "/library");

            expect(deleteThumbnailFile).toHaveBeenCalledWith("thumbnails/a.jpg", "/library");
            expect(deleteMediaFile).toHaveBeenCalledWith("video/a.mp4", "/library");
        });

        it("does nothing when library path is empty", async () => {
            await cleanupCreatedArtifacts("video/a.mp4", "thumbnails/a.jpg", "   ");

            expect(deleteThumbnailFile).not.toHaveBeenCalled();
            expect(deleteMediaFile).not.toHaveBeenCalled();
        });

        it("continues cleanup even when one operation fails", async () => {
            vi.mocked(deleteThumbnailFile).mockRejectedValueOnce(new Error("thumb error"));
            vi.mocked(deleteMediaFile).mockResolvedValue(undefined);

            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

            await cleanupCreatedArtifacts("video/a.mp4", "thumbnails/a.jpg", "/library");

            expect(deleteThumbnailFile).toHaveBeenCalledWith("thumbnails/a.jpg", "/library");
            expect(deleteMediaFile).toHaveBeenCalledWith("video/a.mp4", "/library");
            expect(consoleErrorSpy).toHaveBeenCalled();

            consoleErrorSpy.mockRestore();
        });
    });
});