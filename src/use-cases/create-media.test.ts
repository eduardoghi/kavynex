import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services", () => ({
    createMedia: vi.fn(),
}));

import { createMedia } from "../services";
import { executeCreateMedia } from "./create-media";

const createMediaMock = vi.mocked(createMedia);

describe("executeCreateMedia", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("creates media and reloads the selected channel", async () => {
        const reloadMedia = vi.fn().mockResolvedValue(undefined);

        const input = {
            channelId: 10,
            title: "Video A",
            sourceMode: "local" as const,
            sourceValue: "/tmp/video.mp4",
            thumbnailSourcePath: "/tmp/thumb.jpg",
            mediaType: "video" as const,
            importMode: "copy" as const,
            libraryPath: "/library",
            publishedAt: "2026-03-30",
            ytDlpRunId: "",
            ytDlpFormatId: "",
            downloadComments: false,
            downloadLiveChat: false,
            cookiesBrowser: null,
        };

        await executeCreateMedia({
            input,
            reloadMedia,
        });

        expect(createMediaMock).toHaveBeenCalledWith(input);
        expect(reloadMedia).toHaveBeenCalledWith(10);
    });
});