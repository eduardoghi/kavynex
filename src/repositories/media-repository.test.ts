import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
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

    it("listMediaByChannel passes channel id and returns rows", async () => {
        const rows = [{ id: 1 }];
        invokeCommandMock.mockResolvedValueOnce(rows as never);

        await expect(listMediaByChannel(3)).resolves.toBe(rows);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.LIST_MEDIA_BY_CHANNEL, {
            channelId: 3,
        });
    });

    it("findMediaByChannelAndFilePath passes channel id and file path", async () => {
        await findMediaByChannelAndFilePath(3, "video/a.mp4");
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.FIND_MEDIA_BY_CHANNEL_AND_FILE_PATH,
            { channelId: 3, filePath: "video/a.mp4" }
        );
    });

    it("insertMedia passes every field and returns the new id", async () => {
        invokeCommandMock.mockResolvedValueOnce(101 as never);

        await expect(
            insertMedia(
                3,
                "Video A",
                "video/a.mp4",
                "thumb/a.jpg",
                "video",
                "yt1",
                "2026-01-01",
                120,
                false,
                "live_chat/a.json"
            )
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

    it("deleteMediaById passes the media id", async () => {
        await deleteMediaById(9);
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.DELETE_MEDIA_BY_ID, {
            mediaId: 9,
        });
    });

    it("markMediaAsWatched passes the media id", async () => {
        await markMediaAsWatched(9);
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.MARK_MEDIA_AS_WATCHED, {
            mediaId: 9,
        });
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

    it("countMediaUsingThumbnailOutsideMedia passes path and id", async () => {
        invokeCommandMock.mockResolvedValueOnce(1 as never);

        await expect(
            countMediaUsingThumbnailOutsideMedia("thumb/s.jpg", 5)
        ).resolves.toBe(1);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.COUNT_MEDIA_USING_THUMBNAIL_OUTSIDE_MEDIA,
            { thumbnailPath: "thumb/s.jpg", mediaId: 5 }
        );
    });

    it("countMediaUsingFilePathOutsideMedia passes path and id", async () => {
        invokeCommandMock.mockResolvedValueOnce(2 as never);

        await expect(
            countMediaUsingFilePathOutsideMedia("video/s.mp4", 5)
        ).resolves.toBe(2);
        expect(invokeCommandMock).toHaveBeenCalledWith(
            TAURI_COMMANDS.COUNT_MEDIA_USING_FILE_PATH_OUTSIDE_MEDIA,
            { filePath: "video/s.mp4", mediaId: 5 }
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
