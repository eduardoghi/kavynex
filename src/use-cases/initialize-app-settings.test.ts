import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeAppSettings } from "./initialize-app-settings";

vi.mock("../services/library-service", () => ({
    resolveExistingDirectory: vi.fn(),
    ensureDirectoryExists: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import {
    ensureDirectoryExists,
    resolveExistingDirectory,
} from "../services/library-service";
import { logError } from "../utils/app-logger";

describe("initializeAppSettings", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("resolves and ensures the stored library path without warning", async () => {
        vi.mocked(resolveExistingDirectory).mockResolvedValueOnce("/library/resolved");
        vi.mocked(ensureDirectoryExists).mockResolvedValueOnce("/library/resolved");

        const result = await initializeAppSettings({
            storedSettings: { importMode: "copy", libraryPath: "/library" },
        });

        expect(resolveExistingDirectory).toHaveBeenCalledWith("/library");
        expect(ensureDirectoryExists).toHaveBeenCalledWith("/library/resolved");
        expect(result.settings.libraryPath).toBe("/library/resolved");
        expect(result.shouldWarnAboutLibraryPath).toBe(false);
        expect(logError).not.toHaveBeenCalled();
    });

    it("clears the path and warns when the stored directory cannot be resolved", async () => {
        vi.mocked(resolveExistingDirectory).mockRejectedValueOnce(new Error("missing"));

        const result = await initializeAppSettings({
            storedSettings: { importMode: "copy", libraryPath: "/library" },
        });

        expect(ensureDirectoryExists).not.toHaveBeenCalled();
        expect(result.settings.libraryPath).toBe("");
        expect(result.shouldWarnAboutLibraryPath).toBe(true);
        expect(logError).toHaveBeenCalled();
    });

    it("clears the path and warns when the directory cannot be ensured", async () => {
        vi.mocked(resolveExistingDirectory).mockResolvedValueOnce("/library/resolved");
        vi.mocked(ensureDirectoryExists).mockRejectedValueOnce(new Error("no access"));

        const result = await initializeAppSettings({
            storedSettings: { importMode: "move", libraryPath: "/library" },
        });

        expect(result.settings.libraryPath).toBe("");
        expect(result.shouldWarnAboutLibraryPath).toBe(true);
        expect(logError).toHaveBeenCalled();
    });

    it("does not warn on a fresh install with no stored library path", async () => {
        const result = await initializeAppSettings({
            storedSettings: { importMode: "copy", libraryPath: "" },
        });

        expect(resolveExistingDirectory).not.toHaveBeenCalled();
        expect(ensureDirectoryExists).not.toHaveBeenCalled();
        expect(result.settings.libraryPath).toBe("");
        expect(result.shouldWarnAboutLibraryPath).toBe(false);
        expect(logError).not.toHaveBeenCalled();
    });

    it("normalizes the import mode", async () => {
        vi.mocked(resolveExistingDirectory).mockResolvedValue("/library");
        vi.mocked(ensureDirectoryExists).mockResolvedValue("/library");

        const moved = await initializeAppSettings({
            storedSettings: { importMode: "move", libraryPath: "/library" },
        });
        expect(moved.settings.importMode).toBe("move");

        const copied = await initializeAppSettings({
            storedSettings: {
                importMode: "unexpected" as never,
                libraryPath: "/library",
            },
        });
        expect(copied.settings.importMode).toBe("copy");
    });
});
