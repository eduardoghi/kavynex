import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

import { invokeCommand } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { importMediaFile } from "./media-file-service";
import { ClientError } from "../utils/app-error";

describe("importMediaFile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("rejects a blank source path without calling the backend", async () => {
        await expect(importMediaFile("   ", "copy", "/library")).rejects.toBeInstanceOf(
            ClientError
        );
        await expect(importMediaFile("   ", "copy", "/library")).rejects.toThrow(
            "Source media path is required."
        );
        expect(invokeCommand).not.toHaveBeenCalled();
    });

    it("rejects a blank library path without calling the backend", async () => {
        await expect(
            importMediaFile("/tmp/video.mp4", "copy", "   ")
        ).rejects.toThrow("Library path is required.");
        expect(invokeCommand).not.toHaveBeenCalled();
    });

    it("trims the source and library paths before invoking the command", async () => {
        vi.mocked(invokeCommand).mockResolvedValueOnce("video/media_abc.mp4");

        const result = await importMediaFile("  /tmp/video.mp4  ", "move", "  /library  ");

        expect(invokeCommand).toHaveBeenCalledWith(TAURI_COMMANDS.IMPORT_MEDIA_FILE, {
            path: "/tmp/video.mp4",
            mode: "move",
            libraryPath: "/library",
        });
        expect(result).toBe("video/media_abc.mp4");
    });

    it("normalizes the relative path returned by the backend", async () => {
        vi.mocked(invokeCommand).mockResolvedValueOnce("  video/media_abc.mp4  ");

        await expect(importMediaFile("/tmp/video.mp4", "copy", "/library")).resolves.toBe(
            "video/media_abc.mp4"
        );
    });
});
