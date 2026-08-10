import { beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "../lib/tauri-platform";
import { invokeVoid } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { openExternalUrl, openLogDirectory } from "./library-service";

vi.mock("../lib/tauri-platform", () => ({
    openUrl: vi.fn(),
    openFileDialog: vi.fn(),
}));

vi.mock("../lib/tauri-client", () => ({
    invokeVoid: vi.fn(),
    invokeCommand: vi.fn(),
}));

const openUrlMock = vi.mocked(openUrl);
const invokeVoidMock = vi.mocked(invokeVoid);

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

describe("openLogDirectory", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        invokeVoidMock.mockResolvedValue(undefined);
    });

    it("invokes the log-directory command", async () => {
        await openLogDirectory();

        expect(invokeVoidMock).toHaveBeenCalledTimes(1);
        expect(invokeVoidMock).toHaveBeenCalledWith(TAURI_COMMANDS.OPEN_LOG_DIRECTORY);
    });

    it("sends no arguments at all", async () => {
        // The security property of this command, asserted rather than left to the signature. The
        // backend resolves the log directory from `app_log_dir()` precisely so there is no path for
        // a caller to redirect; a second argument appearing here would mean a path had been
        // reintroduced on the way in, which is the change that should have to delete this test.
        await openLogDirectory();

        const [command, ...rest] = invokeVoidMock.mock.calls[0] ?? [];

        expect(command).toBe(TAURI_COMMANDS.OPEN_LOG_DIRECTORY);
        expect(rest).toEqual([]);
    });

    it("propagates a failure to the caller", async () => {
        // The hook above it turns this into a user-facing notice; swallowing it here would leave a
        // button that silently does nothing, which is the whole failure mode worth avoiding.
        invokeVoidMock.mockRejectedValueOnce(new Error("no file manager"));

        await expect(openLogDirectory()).rejects.toThrow("no file manager");
    });
});
