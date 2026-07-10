import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import {
    cancelMediaDownload,
    downloadMediaFromUrl,
    listYtDlpFormats,
} from "./media-download-service";

describe("media-download-service", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns empty formats result when url is empty", async () => {
        await expect(listYtDlpFormats("   ")).resolves.toEqual({
            suggested_title: "",
            youtube_video_id: null,
            formats: [],
            terminal_logs: [],
        });

        expect(invokeCommand).not.toHaveBeenCalled();
    });

    it("loads yt-dlp formats when url is valid", async () => {
        vi.mocked(invokeCommand).mockResolvedValueOnce({
            suggested_title: "Video A",
            formats: [],
            terminal_logs: [],
        });

        await expect(listYtDlpFormats("https://youtube.com/watch?v=abc")).resolves.toEqual({
            suggested_title: "Video A",
            formats: [],
            terminal_logs: [],
        });

        expect(invokeCommand).toHaveBeenCalledWith("list_yt_dlp_formats", {
            url: "https://youtube.com/watch?v=abc",
            cookiesBrowser: null,
            cookiesPath: null,
        });
    });

    it("downloads media when all arguments are valid", async () => {
        vi.mocked(invokeCommand).mockResolvedValueOnce({
            file_path: "video/a.mp4",
            suggested_title: "Video A",
            youtube_video_id: "abc123",
            published_at: "2026-03-31",
            media_type: "video",
            thumbnail_url: "https://example.com/thumb.jpg",
            thumbnail_path: null,
            is_live: false,
            live_chat_file_path: null,
        });

        await expect(
            downloadMediaFromUrl(
                "https://youtube.com/watch?v=abc",
                "/library",
                "run-1",
                "best"
            )
        ).resolves.toEqual({
            file_path: "video/a.mp4",
            suggested_title: "Video A",
            youtube_video_id: "abc123",
            published_at: "2026-03-31",
            media_type: "video",
            thumbnail_url: "https://example.com/thumb.jpg",
            thumbnail_path: null,
            is_live: false,
            live_chat_file_path: null,
        });

        expect(invokeCommand).toHaveBeenCalledWith("download_media_from_url", {
            url: "https://youtube.com/watch?v=abc",
            libraryPath: "/library",
            runId: "run-1",
            formatId: "best",
            downloadLiveChat: false,
            skipAutoThumbnailDownload: false,
            cookiesBrowser: null,
            cookiesPath: null,
        });
    });

    it("rejects empty download arguments", async () => {
        await expect(downloadMediaFromUrl("", "/library", "run-1", "best")).rejects.toThrow(
            "url is empty"
        );

        await expect(
            downloadMediaFromUrl("https://youtube.com/watch?v=abc", "", "run-1", "best")
        ).rejects.toThrow("library path is empty");

        await expect(
            downloadMediaFromUrl("https://youtube.com/watch?v=abc", "/library", "", "best")
        ).rejects.toThrow("run id is empty");

        await expect(
            downloadMediaFromUrl("https://youtube.com/watch?v=abc", "/library", "run-1", "")
        ).rejects.toThrow("format id is empty");
    });

    it("cancels media download", async () => {
        vi.mocked(invokeVoid).mockResolvedValueOnce(undefined);

        await cancelMediaDownload("run-1");

        expect(invokeVoid).toHaveBeenCalledWith("cancel_media_download", {
            runId: "run-1",
        });
    });

    it("rejects empty run id when cancelling", async () => {
        await expect(cancelMediaDownload("   ")).rejects.toThrow("run id is empty");
        expect(invokeVoid).not.toHaveBeenCalled();
    });
});