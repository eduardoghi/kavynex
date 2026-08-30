import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import { cancelMediaDownload, listYtDlpFormats } from "./media-download-service";

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
            youtube_video_id: "abc",
            formats: [],
            terminal_logs: [],
        });

        await expect(listYtDlpFormats("https://youtube.com/watch?v=abc")).resolves.toEqual({
            suggested_title: "Video A",
            youtube_video_id: "abc",
            formats: [],
            terminal_logs: [],
        });

        expect(invokeCommand).toHaveBeenCalledWith("list_yt_dlp_formats", {
            url: "https://youtube.com/watch?v=abc",
            cookiesBrowser: null,
            cookiesPath: null,
            runId: null,
        });
    });

    // The download itself is no longer invoked from this module. It is a step of a media creation,
    // and the backend owns that sequence now (`create_media`). Its argument validation moved with
    // it, into `media_creation::normalize_create_media_request`, which is tested there.

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