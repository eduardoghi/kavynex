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

    it("resolves and ensures the stored library path", async () => {
        vi.mocked(resolveExistingDirectory).mockResolvedValueOnce("/library/resolved");
        vi.mocked(ensureDirectoryExists).mockResolvedValueOnce("/library/resolved");

        const result = await initializeAppSettings({
            storedSettings: {
                importMode: "copy",
                libraryPath: "/library",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
                externalBackupDir: "",
            },
        });

        expect(resolveExistingDirectory).toHaveBeenCalledWith("/library");
        expect(ensureDirectoryExists).toHaveBeenCalledWith("/library/resolved");
        expect(result.settings.libraryPath).toBe("/library/resolved");
        expect(result.libraryUnreachable).toBe(false);
        expect(logError).not.toHaveBeenCalled();
    });

    it("keeps the stored path and reports it unreachable when it cannot be resolved", async () => {
        // A drive that is not connected. Clearing the path here is what made reconnecting and
        // restarting useless, since nothing was left to reconnect to, and what let the next folder
        // picked be applied as a first library without the backend asking.
        const resolveError = new Error("missing");
        vi.mocked(resolveExistingDirectory).mockRejectedValueOnce(resolveError);

        const result = await initializeAppSettings({
            storedSettings: {
                importMode: "copy",
                libraryPath: "/library",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
                externalBackupDir: "",
            },
        });

        expect(ensureDirectoryExists).not.toHaveBeenCalled();
        expect(result.settings.libraryPath).toBe("/library");
        expect(result.libraryUnreachable).toBe(true);
        expect(logError).toHaveBeenCalledWith(
            "settings",
            "The stored library directory is unreachable.",
            resolveError,
            { libraryPath: "/library" }
        );
    });

    it("keeps the stored path, not the resolved one, when the directory cannot be ensured", async () => {
        const ensureError = new Error("no access");
        vi.mocked(resolveExistingDirectory).mockResolvedValueOnce("/library/resolved");
        vi.mocked(ensureDirectoryExists).mockRejectedValueOnce(ensureError);

        const result = await initializeAppSettings({
            storedSettings: {
                importMode: "move",
                libraryPath: "/library",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
                externalBackupDir: "",
            },
        });

        expect(result.settings.libraryPath).toBe("/library");
        expect(result.libraryUnreachable).toBe(true);
    });

    it("treats a whitespace-only stored path as empty without touching the filesystem", async () => {
        const result = await initializeAppSettings({
            storedSettings: {
                importMode: "copy",
                libraryPath: "   ",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
                externalBackupDir: "",
            },
        });

        expect(resolveExistingDirectory).not.toHaveBeenCalled();
        expect(ensureDirectoryExists).not.toHaveBeenCalled();
        expect(result.settings.libraryPath).toBe("");
        expect(result.libraryUnreachable).toBe(false);
    });

    it("does not report a fresh install with no stored library path as unreachable", async () => {
        const result = await initializeAppSettings({
            storedSettings: {
                importMode: "copy",
                libraryPath: "",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
                externalBackupDir: "",
            },
        });

        expect(resolveExistingDirectory).not.toHaveBeenCalled();
        expect(ensureDirectoryExists).not.toHaveBeenCalled();
        expect(result.settings.libraryPath).toBe("");
        expect(result.libraryUnreachable).toBe(false);
        expect(logError).not.toHaveBeenCalled();
    });

    it("normalizes the import mode", async () => {
        vi.mocked(resolveExistingDirectory).mockResolvedValue("/library");
        vi.mocked(ensureDirectoryExists).mockResolvedValue("/library");

        const moved = await initializeAppSettings({
            storedSettings: {
                importMode: "move",
                libraryPath: "/library",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
                externalBackupDir: "",
            },
        });
        expect(moved.settings.importMode).toBe("move");

        const copied = await initializeAppSettings({
            storedSettings: {
                importMode: "unexpected" as never,
                libraryPath: "/library",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
                externalBackupDir: "",
            },
        });
        expect(copied.settings.importMode).toBe("copy");
    });
});
