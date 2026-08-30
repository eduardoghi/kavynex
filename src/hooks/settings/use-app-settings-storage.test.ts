import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    getStoredAppSettings,
    setExternalBackupDir,
    setStoredAppSettings,
} from "../../services/app-settings-command-service";
import {
    getDefaultAppSettings,
    loadStoredSettings,
    persistSettings,
    updateStoredCheckUpdatesOnStartup,
    updateStoredExternalBackupDir,
    updateStoredImportMode,
    updateStoredLibraryPath,
    updateStoredLoadRemoteImages,
} from "./use-app-settings-storage";

vi.mock("../../services/app-settings-command-service", () => ({
    getStoredAppSettings: vi.fn(),
    setStoredAppSettings: vi.fn(),
    setExternalBackupDir: vi.fn(),
}));

describe("use-app-settings-storage", () => {
    beforeEach(() => {
        vi.restoreAllMocks();

        vi.mocked(setStoredAppSettings).mockResolvedValue(undefined);
        vi.mocked(setExternalBackupDir).mockResolvedValue(undefined);
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: null,
            libraryPath: null,
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
            externalBackupDir: null,
        });
    });

    it("does not lose a concurrent update to a different setting", async () => {
        // Model the real backend. The row holds all four values, a read returns what the last
        // write stored, and a write is not instant. Without serialization both updates below
        // read the same pre-change snapshot and the second write reverts the first one's field.
        // The two toggles this covers (Privacy and Application update) render in the same modal,
        // and their callers are fire-and-forget, so nothing else orders these writes.
        const row = {
            importMode: "copy" as string | null,
            libraryPath: null as string | null,
            loadRemoteImages: "false" as string | null,
            checkUpdatesOnStartup: "false" as string | null,
            externalBackupDir: null,
        };

        const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

        vi.mocked(getStoredAppSettings).mockImplementation(async () => {
            await settle();
            return { ...row };
        });

        vi.mocked(setStoredAppSettings).mockImplementation(
            async (importMode, libraryPath, loadRemoteImages, checkUpdatesOnStartup) => {
                await settle();
                row.importMode = importMode;
                row.libraryPath = libraryPath;
                row.loadRemoteImages = String(loadRemoteImages);
                row.checkUpdatesOnStartup = String(checkUpdatesOnStartup);
            }
        );

        await Promise.all([
            updateStoredLoadRemoteImages(true),
            updateStoredCheckUpdatesOnStartup(true),
        ]);

        // Both toggles must survive. Neither may be reverted by the other's write.
        expect(row.loadRemoteImages).toBe("true");
        expect(row.checkUpdatesOnStartup).toBe("true");
    });

    it("returns default settings", () => {
        expect(getDefaultAppSettings()).toEqual({
            importMode: "copy",
            libraryPath: "",
            loadRemoteImages: false,
            checkUpdatesOnStartup: true,
            externalBackupDir: "",
        });
    });

    it("loads default settings when backend has no stored values", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: null,
            libraryPath: null,
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
            externalBackupDir: null,
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "",
            loadRemoteImages: false,
            checkUpdatesOnStartup: true,
            externalBackupDir: "",
        });

        expect(getStoredAppSettings).toHaveBeenCalledTimes(1);
    });

    it("loads stored settings from backend", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "  /library  ",
            loadRemoteImages: "false",
            checkUpdatesOnStartup: null,
            externalBackupDir: null,
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: true,
            externalBackupDir: "",
        });
    });

    it("falls back to copy when import mode from backend is invalid", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "invalid-mode",
            libraryPath: "/library",
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
            externalBackupDir: null,
        });

        await expect(loadStoredSettings()).resolves.toEqual({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: true,
            externalBackupDir: "",
        });
    });

    it("only treats an explicit \"true\" as remote images enabled", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: null,
            libraryPath: null,
            loadRemoteImages: "true",
            checkUpdatesOnStartup: null,
            externalBackupDir: null,
        });

        await expect(loadStoredSettings()).resolves.toMatchObject({
            loadRemoteImages: true,
            checkUpdatesOnStartup: true,
            externalBackupDir: "",
        });
    });

    it("keeps remote images off for any non-\"true\" stored value", async () => {
        for (const stored of ["false", "1", "yes", ""]) {
            vi.mocked(getStoredAppSettings).mockResolvedValue({
                importMode: null,
                libraryPath: null,
                loadRemoteImages: stored,
                checkUpdatesOnStartup: null,
                externalBackupDir: null,
            });

            await expect(loadStoredSettings()).resolves.toMatchObject({
                loadRemoteImages: false,
                checkUpdatesOnStartup: true,
                externalBackupDir: "",
            });
        }
    });

    it("keeps the startup update check on unless it was explicitly turned off", async () => {
        // The one opt-out setting here, and the mirror image of the remote-images rule right
        // above, which is why it gets its own test rather than riding along on the fixtures of
        // tests about something else. Those cover it incidentally and would keep passing if the
        // rule became `value === "true"` again for a stored value none of them exercises.
        //
        // The `null` case is the one with a consequence beyond a fresh install. Every database
        // written before this default flipped has the key absent, so this row is what decides that
        // an existing library starts checking for updates rather than staying silently on an old
        // version. The `"false"` case is the other half. A user who opted out has to keep that,
        // or the flip would reach past the installs that never decided and overrule the ones that
        // did.
        for (const [stored, expected] of [
            [null, true],
            ["false", false],
            ["true", true],
            // Not "false" is on, so a value nothing writes today (a hand-edited row, an older
            // spelling) fails safe toward being told about a security fix.
            ["", true],
            ["0", true],
            ["no", true],
        ] as const) {
            vi.mocked(getStoredAppSettings).mockResolvedValue({
                importMode: null,
                libraryPath: null,
                loadRemoteImages: null,
                checkUpdatesOnStartup: stored,
                externalBackupDir: null,
            });

            await expect(loadStoredSettings()).resolves.toMatchObject({
                checkUpdatesOnStartup: expected,
            });
        }
    });

    it("persists settings through the backend command", async () => {
        await persistSettings({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("copy", "/library", true, false);
    });

    it("trims the library path before persisting settings", async () => {
        await persistSettings({
            importMode: "copy",
            libraryPath: "  /library  ",
            loadRemoteImages: false,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("copy", "/library", false, false);
    });

    it("updates only import mode preserving current library path and remote images", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: "false",
            checkUpdatesOnStartup: null,
            externalBackupDir: null,
        });

        const result = await updateStoredImportMode("move");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: true,
            externalBackupDir: "",
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/library", false, true);
    });

    it("updates only library path preserving current import mode and remote images", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/old-library",
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
            externalBackupDir: null,
        });

        const result = await updateStoredLibraryPath("  /new-library  ");

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/new-library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: true,
            externalBackupDir: "",
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/new-library", false, true);
    });

    it("updates only the remote images preference preserving the other settings", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: null,
            checkUpdatesOnStartup: null,
            externalBackupDir: null,
        });

        const result = await updateStoredLoadRemoteImages(false);

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: false,
            checkUpdatesOnStartup: true,
            externalBackupDir: "",
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/library", false, true);
    });

    it("updates only the startup update-check preference preserving the other settings", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: "true",
            checkUpdatesOnStartup: null,
            externalBackupDir: null,
        });

        const result = await updateStoredCheckUpdatesOnStartup(true);

        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: true,
            externalBackupDir: "",
        });

        expect(setStoredAppSettings).toHaveBeenCalledWith("move", "/library", true, true);
    });

    it("persists the external backup directory through its own command, not the whole-row write", async () => {
        vi.mocked(getStoredAppSettings).mockResolvedValue({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: "true",
            checkUpdatesOnStartup: "true",
            externalBackupDir: null,
        });

        const result = await updateStoredExternalBackupDir("  /mnt/backups  ");

        // The path is trimmed and merged into the returned settings.
        expect(result).toEqual({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: true,
            externalBackupDir: "/mnt/backups",
        });

        // It goes through the dedicated command; the whole-row settings write is never touched.
        expect(setExternalBackupDir).toHaveBeenCalledWith("/mnt/backups");
        expect(setStoredAppSettings).not.toHaveBeenCalled();
    });

    it("turns the external backup off with an empty path", async () => {
        await updateStoredExternalBackupDir("");

        expect(setExternalBackupDir).toHaveBeenCalledWith("");
    });
});
