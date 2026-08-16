import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import {
    createMedia,
    deleteMediaWithArtifacts,
    getMediaRepositoryStats,
    listMediaCommentsByMediaId,
    markMediaAsUnwatched,
    markMediaAsWatched,
    updateMediaDuration,
    updateMediaProgress,
    updateMediaTitle,
} from "./media-repository";
import type { CreateMediaRequest } from "../types/generated/CreateMediaRequest";

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

    it("createMedia sends the whole request under one argument and returns the created media", async () => {
        // The request is nested under `request` because the command takes it as a single struct.
        // Spreading it into top-level arguments would type-check on this side and fail to
        // deserialize on the other, which is the mistake worth pinning at the seam.
        const created = {
            id: 101,
            filePath: "video/media_a.mp4",
            thumbnailPath: "thumbnails/thumb_a.jpg",
            mediaType: "video" as const,
            youtubeVideoId: "yt1",
            liveChatFilePath: null,
            isLive: false,
        };
        invokeCommandMock.mockResolvedValueOnce(created as never);

        const request: CreateMediaRequest = {
            channelId: 3,
            title: "Video A",
            sourceMode: "yt-dlp",
            sourceValue: "https://www.youtube.com/watch?v=yt1",
            thumbnailSourcePath: null,
            mediaType: "video",
            importMode: "copy",
            libraryPath: "/library",
            publishedAt: "2026-01-01",
            ytDlpRunId: "run-1",
            ytDlpFormatId: "137+140",
            ytDlpYoutubeVideoId: "yt1",
            downloadLiveChat: false,
            cookiesBrowser: null,
            cookiesPath: null,
        };

        await expect(createMedia(request)).resolves.toBe(created);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.CREATE_MEDIA, { request });
    });

    it("updateMediaDuration passes id and duration, including a null measurement", async () => {
        await updateMediaDuration(9, 125);
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.UPDATE_MEDIA_DURATION, {
            mediaId: 9,
            durationSeconds: 125,
        });

        // A file the probe could not read reports null, and that has to reach the command as null
        // rather than being dropped: the argument is not optional on the Rust side.
        await updateMediaDuration(9, null);
        expect(invokeVoidMock).toHaveBeenLastCalledWith(TAURI_COMMANDS.UPDATE_MEDIA_DURATION, {
            mediaId: 9,
            durationSeconds: null,
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

    it("getMediaRepositoryStats invokes the stats command", async () => {
        const stats = { total_media: 3 };
        invokeCommandMock.mockResolvedValueOnce(stats as never);

        await expect(getMediaRepositoryStats()).resolves.toBe(stats);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.GET_MEDIA_REPOSITORY_STATS);
    });

});
