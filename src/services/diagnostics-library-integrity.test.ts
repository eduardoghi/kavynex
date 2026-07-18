import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
}));

vi.mock("../repositories/channel-repository", () => ({
    listChannels: vi.fn(),
}));

vi.mock("../repositories/media-repository", () => ({
    listMediaIntegrityReferences: vi.fn(),
}));

import { invokeCommand } from "../lib/tauri-client";
import { listChannels } from "../repositories/channel-repository";
import { listMediaIntegrityReferences } from "../repositories/media-repository";
import { getLibraryIntegrity } from "./diagnostics-library-integrity";
import { TAURI_COMMANDS } from "../constants/tauri-commands";

const invokeCommandMock = vi.mocked(invokeCommand);
const listChannelsMock = vi.mocked(listChannels);
const listMediaIntegrityReferencesMock = vi.mocked(listMediaIntegrityReferences);

describe("getLibraryIntegrity", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        invokeCommandMock.mockResolvedValue({} as never);
    });

    it("includes channel avatar paths in the expected thumbnail set", async () => {
        listMediaIntegrityReferencesMock.mockResolvedValueOnce([
            {
                id: 1,
                channel_id: 10,
                title: "Video A",
                file_path: "video/a.mp4",
                thumbnail_path: "thumbnails/a.jpg",
                live_chat_file_path: "live_chat/a.json.gz",
            },
        ]);
        listChannelsMock.mockResolvedValueOnce([
            {
                id: 10,
                name: "Channel",
                youtube_handle: "@channel",
                avatar_path: "thumbnails/avatar.jpg",
                created_at: "2026-07-11T00:00:00Z",
            },
        ] as never);

        await getLibraryIntegrity("/library");

        expect(invokeCommandMock).toHaveBeenCalledTimes(1);
        const payload = invokeCommandMock.mock.calls[0]![1] as {
            libraryPath: string;
            mediaPaths: string[];
            thumbnailPaths: string[];
            liveChatPaths: string[];
        };

        expect(invokeCommandMock.mock.calls[0]![0]).toBe(TAURI_COMMANDS.CHECK_LIBRARY_INTEGRITY);
        // The avatar is referenced by the channels table, not by any media row: without it the
        // integrity check would wrongly report it as an orphan thumbnail.
        expect(payload.thumbnailPaths).toContain("thumbnails/avatar.jpg");
        expect(payload.thumbnailPaths).toContain("thumbnails/a.jpg");
        expect(payload.mediaPaths).toContain("video/a.mp4");
        // Live chat replay paths are forwarded too, so the backend can flag a missing/corrupt/
        // orphan live chat file the same way it does for media and thumbnails.
        expect(payload.liveChatPaths).toContain("live_chat/a.json.gz");
    });

    it("skips the backend call and both queries when the library path is blank", async () => {
        const result = await getLibraryIntegrity("   ");

        expect(result.report.checked_media_files).toBe(0);
        expect(result.mediaByPath).toEqual({});
        expect(invokeCommandMock).not.toHaveBeenCalled();
        expect(listChannelsMock).not.toHaveBeenCalled();
        expect(listMediaIntegrityReferencesMock).not.toHaveBeenCalled();
    });
});
