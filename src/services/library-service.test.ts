import { beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openExternalUrl } from "./library-service";

vi.mock("@tauri-apps/plugin-opener", () => ({
    openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
    open: vi.fn(),
}));

const openUrlMock = vi.mocked(openUrl);

describe("openExternalUrl", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        openUrlMock.mockResolvedValue(null as never);
    });

    it("opens https urls", async () => {
        await openExternalUrl("https://www.youtube.com/watch?v=abc");
        expect(openUrlMock).toHaveBeenCalledWith("https://www.youtube.com/watch?v=abc");
    });

    it("opens http urls", async () => {
        await openExternalUrl("http://example.com/");
        expect(openUrlMock).toHaveBeenCalledWith("http://example.com/");
    });

    it("rejects non-http schemes without opening them", async () => {
        for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://host/x"]) {
            await expect(openExternalUrl(url)).rejects.toThrow();
        }

        expect(openUrlMock).not.toHaveBeenCalled();
    });

    it("rejects empty and malformed urls", async () => {
        await expect(openExternalUrl("   ")).rejects.toThrow("URL is required.");
        await expect(openExternalUrl("not a url")).rejects.toThrow("Invalid URL.");

        expect(openUrlMock).not.toHaveBeenCalled();
    });
});
