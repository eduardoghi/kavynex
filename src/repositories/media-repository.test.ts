import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import {
    cleanupUnreferencedMediaArtifacts,
    deleteMediaWithArtifacts,
    findMediaByChannelAndFilePath,
    getMediaRepositoryStats,
    insertMedia,
    listMediaCommentsByMediaId,
    listMediaIntegrityReferences,
    markMediaAsUnwatched,
    markMediaAsWatched,
    mediaExistsForChannelAndYoutubeId,
    updateMediaProgress,
    updateMediaTitle,
} from "./media-repository";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

const invokeCommandMock = vi.mocked(invokeCommand);
const invokeVoidMock = vi.mocked(invokeVoid);

beforeEach(() => {
    vi.clearAllMocks();
    invokeCommandMock.mockResolvedValue(undefined as never);
    invokeVoidMock.mockResolvedValue(undefined);
});

describe("media-repository command wiring", () => {
    it("updateMediaTitle passes id and title", async () => {
        await updateMediaTitle(5, "New Title");
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.UPDATE_MEDIA_TITLE, {
            mediaId: 5,
            title: "New Title",
        });
    });

    it("findMediaByChannelAndFilePath passes channel id and file path", async () => {
        await findMediaByChannelAndFilePath(3, "video/a.mp4");
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.FIND_MEDIA_BY_CHANNEL_AND_FILE_PATH,
            { channelId: 3, filePath: "video/a.mp4" }
        );
    });

    it("mediaExistsForChannelAndYoutubeId passes channel id and youtube video id and returns the result", async () => {
        invokeCommandMock.mockResolvedValueOnce(true as never);

        await expect(mediaExistsForChannelAndYoutubeId(3, "abc123")).resolves.toBe(true);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.MEDIA_EXISTS_FOR_CHANNEL_AND_YOUTUBE_ID,
            { channelId: 3, youtubeVideoId: "abc123" }
        );
    });

    it("insertMedia passes every field and returns the new id", async () => {
        invokeCommandMock.mockResolvedValueOnce(101 as never);

        await expect(
            insertMedia({
                channelId: 3,
                title: "Video A",
                filePath: "video/a.mp4",
                thumbnailPath: "thumb/a.jpg",
                mediaType: "video",
                youtubeVideoId: "yt1",
                publishedAt: "2026-01-01",
                durationSeconds: 120,
                isLive: false,
                liveChatFilePath: "live_chat/a.json",
            })
        ).resolves.toBe(101);

        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.INSERT_MEDIA, {
            channelId: 3,
            title: "Video A",
            filePath: "video/a.mp4",
            thumbnailPath: "thumb/a.jpg",
            mediaType: "video",
            youtubeVideoId: "yt1",
            publishedAt: "2026-01-01",
            durationSeconds: 120,
            isLive: false,
            liveChatFilePath: "live_chat/a.json",
        });
    });

    it("listMediaCommentsByMediaId passes the media id", async () => {
        await listMediaCommentsByMediaId(7);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.LIST_MEDIA_COMMENTS_BY_MEDIA_ID,
            { mediaId: 7 }
        );
    });

    it("deleteMediaWithArtifacts passes the media id and returns the cleanup report", async () => {
        const report = {
            deleted_paths: ["video/a.mp4"],
            skipped_shared_paths: [],
            failed_paths: [],
        };
        invokeCommandMock.mockResolvedValueOnce(report as never);

        await expect(deleteMediaWithArtifacts(9)).resolves.toBe(report);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.DELETE_MEDIA_WITH_ARTIFACTS, {
            mediaId: 9,
        });
    });

    it("markMediaAsWatched passes the media id and returns the persisted timestamp", async () => {
        invokeCommandMock.mockResolvedValueOnce("2026-07-11 12:00:00" as never);

        const watchedAt = await markMediaAsWatched(9);

        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.MARK_MEDIA_AS_WATCHED, {
            mediaId: 9,
        });
        expect(watchedAt).toBe("2026-07-11 12:00:00");
    });

    it("markMediaAsUnwatched passes the media id", async () => {
        await markMediaAsUnwatched(9);
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.MARK_MEDIA_AS_UNWATCHED, {
            mediaId: 9,
        });
    });

    it("updateMediaProgress passes id and progress", async () => {
        await updateMediaProgress(9, 42);
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.UPDATE_MEDIA_PROGRESS, {
            mediaId: 9,
            progressSeconds: 42,
        });
    });

    it("cleanupUnreferencedMediaArtifacts passes every path and returns the cleanup report", async () => {
        const report = {
            deleted_paths: ["video/a.mp4"],
            skipped_shared_paths: ["thumbnails/shared.jpg"],
            failed_paths: [],
        };
        invokeCommandMock.mockResolvedValueOnce(report as never);

        await expect(
            cleanupUnreferencedMediaArtifacts(
                "video/a.mp4",
                "thumbnails/shared.jpg",
                "live_chat/a.json.gz"
            )
        ).resolves.toBe(report);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.CLEANUP_UNREFERENCED_MEDIA_ARTIFACTS,
            {
                filePath: "video/a.mp4",
                thumbnailPath: "thumbnails/shared.jpg",
                liveChatFilePath: "live_chat/a.json.gz",
            }
        );
    });

    it("getMediaRepositoryStats invokes the stats command", async () => {
        const stats = { total_media: 3 };
        invokeCommandMock.mockResolvedValueOnce(stats as never);

        await expect(getMediaRepositoryStats()).resolves.toBe(stats);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.GET_MEDIA_REPOSITORY_STATS);
    });

    it("listMediaIntegrityReferences invokes the references command", async () => {
        const refs = [{ id: 1 }];
        invokeCommandMock.mockResolvedValueOnce(refs as never);

        await expect(listMediaIntegrityReferences()).resolves.toBe(refs);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.LIST_MEDIA_INTEGRITY_REFERENCES
        );
    });
});
