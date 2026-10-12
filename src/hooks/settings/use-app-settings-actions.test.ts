import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppSettingsActions } from "./use-app-settings-actions";

vi.mock("../../use-cases/change-library-path", () => ({
    planChangeLibraryPath: vi.fn(),
    moveLibrary: vi.fn(),
}));

vi.mock("../../use-cases/initialize-app-settings", () => ({
    initializeAppSettings: vi.fn(),
}));

vi.mock("../../services/library-service", () => ({
    openLibraryDirectory: vi.fn(),
    getLibrarySummary: vi.fn(),
    cancelLibraryMigration: vi.fn(),
    resolveExistingDirectory: vi.fn(),
}));

vi.mock("./use-app-settings-storage", () => ({
    loadStoredSettings: vi.fn(),
    persistSettings: vi.fn(),
    updateStoredImportMode: vi.fn(),
    updateStoredLibraryPath: vi.fn(),
}));

vi.mock("../../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { moveLibrary, planChangeLibraryPath } from "../../use-cases/change-library-path";
import { initializeAppSettings } from "../../use-cases/initialize-app-settings";
import {
    cancelLibraryMigration,
    getLibrarySummary,
    openLibraryDirectory,
    resolveExistingDirectory,
} from "../../services/library-service";
import {
    loadStoredSettings,
    persistSettings,
    updateStoredImportMode,
    updateStoredLibraryPath,
} from "./use-app-settings-storage";
import { logError } from "../../utils/app-logger";

describe("useAppSettingsActions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const NEW_SETTINGS = {
        importMode: "copy" as const,
        libraryPath: "/new-library",
        loadRemoteImages: true,
        checkUpdatesOnStartup: false,
        externalBackupDir: "",
    };

    // The settings as read at startup. changeLibraryPath refuses to run before they are, so every
    // test of it starts from here.
    async function renderLoaded(
        onError = vi.fn(),
        setSettings = vi.fn(),
        onNotice?: (message: string) => void
    ) {
        vi.mocked(initializeAppSettings).mockResolvedValueOnce({
            settings: { ...NEW_SETTINGS, libraryPath: "/library" },
            libraryUnreachable: false,
        });
        vi.mocked(persistSettings).mockResolvedValueOnce(undefined);

        const rendered = renderHook(() =>
            useAppSettingsActions({ onError, onNotice, setSettings })
        );

        await act(async () => {
            await rendered.result.current.prepareSettings();
        });
        setSettings.mockClear();

        return rendered;
    }

    it("prepares settings successfully", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(loadStoredSettings).mockResolvedValueOnce({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        vi.mocked(initializeAppSettings).mockResolvedValueOnce({
            settings: {
                importMode: "copy",
                libraryPath: "/library",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
                externalBackupDir: "",
            },
            libraryUnreachable: false,
        });

        vi.mocked(persistSettings).mockResolvedValueOnce(undefined);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        // Until the read lands, the settings in memory are the defaults, not the user's choices.
        expect(result.current.hasLoadedSettings).toBe(false);

        await act(async () => {
            await result.current.prepareSettings();
        });

        expect(result.current.hasLoadedSettings).toBe(true);
        expect(loadStoredSettings).toHaveBeenCalledTimes(1);
        expect(initializeAppSettings).toHaveBeenCalledWith({
            storedSettings: {
                importMode: "copy",
                libraryPath: "/library",
                loadRemoteImages: true,
                checkUpdatesOnStartup: false,
                externalBackupDir: "",
            },
        });
        expect(setSettings).toHaveBeenCalledWith({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });
        expect(persistSettings).toHaveBeenCalledWith({
            importMode: "copy",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });
        expect(updateStoredLibraryPath).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
    });

    const UNREACHABLE_SETTINGS = {
        importMode: "copy" as const,
        libraryPath: "/library",
        loadRemoteImages: true,
        checkUpdatesOnStartup: false,
        externalBackupDir: "",
    };

    async function renderWithUnreachableLibrary(onError = vi.fn(), setSettings = vi.fn()) {
        vi.mocked(loadStoredSettings).mockResolvedValueOnce(UNREACHABLE_SETTINGS);
        vi.mocked(initializeAppSettings).mockResolvedValueOnce({
            settings: UNREACHABLE_SETTINGS,
            libraryUnreachable: true,
        });

        const rendered = renderHook(() => useAppSettingsActions({ onError, setSettings }));

        await act(async () => {
            await rendered.result.current.prepareSettings();
        });

        return { ...rendered, onError, setSettings };
    }

    function spyOnReload(): ReturnType<typeof vi.fn> {
        const reloadSpy = vi.fn();
        Object.defineProperty(window, "location", {
            configurable: true,
            value: { ...window.location, reload: reloadSpy },
        });
        return reloadSpy;
    }

    it("keeps an unreachable library configured and writes nothing", async () => {
        // The drive is not connected. The path used to be cleared and written back empty, so
        // reconnecting and restarting found nothing to reconnect to.
        const { result, onError, setSettings } = await renderWithUnreachableLibrary();

        expect(persistSettings).not.toHaveBeenCalled();
        expect(updateStoredLibraryPath).not.toHaveBeenCalled();
        expect(setSettings).toHaveBeenCalledWith(UNREACHABLE_SETTINGS);
        expect(result.current.isLibraryUnreachable).toBe(true);
        expect(result.current.hasLoadedSettings).toBe(true);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            expect.stringContaining("cannot reach the library folder /library")
        );
        expect(onError).toHaveBeenCalledWith(expect.stringContaining("nothing was changed"));
    });

    it("reloads once the unreachable folder answers again", async () => {
        const { result, onError } = await renderWithUnreachableLibrary();
        const reloadSpy = spyOnReload();
        vi.mocked(resolveExistingDirectory).mockResolvedValueOnce("/library");

        await act(async () => {
            await result.current.retryLibraryFolder("/library");
        });

        expect(resolveExistingDirectory).toHaveBeenCalledWith("/library");
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        // Only the startup notice.
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("says so when the folder still cannot be reached", async () => {
        const { result, onError } = await renderWithUnreachableLibrary();
        const reloadSpy = spyOnReload();
        vi.mocked(resolveExistingDirectory).mockRejectedValueOnce(new Error("missing"));

        await act(async () => {
            await result.current.retryLibraryFolder("/library");
        });

        expect(reloadSpy).not.toHaveBeenCalled();
        expect(onError).toHaveBeenLastCalledWith(
            expect.stringContaining("still cannot reach /library")
        );
        expect(result.current.isLibraryUnreachable).toBe(true);
    });

    it("asks to switch without moving when another folder is chosen for an unreachable one", async () => {
        // The question the backend would raise (LIBRARY_FOLDER_UNREACHABLE), asked up front. With
        // the path cleared this used to be a first library, applied without asking anything.
        const { result, setSettings } = await renderWithUnreachableLibrary();
        vi.mocked(planChangeLibraryPath).mockResolvedValueOnce({
            kind: "move",
            currentLibraryPath: "/library",
            destination: "/new-library",
        });

        await act(async () => {
            await result.current.changeLibraryPath("/library");
        });

        expect(getLibrarySummary).not.toHaveBeenCalled();
        expect(result.current.pendingLibraryMove).toEqual({
            currentLibraryPath: "/library",
            destination: "/new-library",
            summary: null,
            currentFolderUnreachable: true,
        });

        vi.mocked(moveLibrary).mockResolvedValueOnce({
            changed: true,
            finalLibraryPath: "/new-library",
            oldDirectoryRetained: false,
        });
        vi.mocked(updateStoredLibraryPath).mockResolvedValueOnce(NEW_SETTINGS);

        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        expect(moveLibrary).toHaveBeenCalledWith(
            expect.objectContaining({ currentFolderUnreachable: true }),
            expect.any(Function)
        );
        expect(setSettings).toHaveBeenLastCalledWith(NEW_SETTINGS);
        expect(result.current.isLibraryUnreachable).toBe(false);
    });

    it("treats choosing the same folder again as reconnecting it", async () => {
        const { result, onError } = await renderWithUnreachableLibrary();
        const reloadSpy = spyOnReload();
        vi.mocked(planChangeLibraryPath).mockResolvedValueOnce({ kind: "unchanged" });
        vi.mocked(resolveExistingDirectory).mockResolvedValueOnce("/library");

        await act(async () => {
            await result.current.changeLibraryPath("/library");
        });

        expect(reloadSpy).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("stays quiet when the dialog is cancelled and the folder is still missing", async () => {
        const { result, onError } = await renderWithUnreachableLibrary();
        const reloadSpy = spyOnReload();
        vi.mocked(planChangeLibraryPath).mockResolvedValueOnce({ kind: "unchanged" });
        vi.mocked(resolveExistingDirectory).mockRejectedValueOnce(new Error("missing"));

        await act(async () => {
            await result.current.changeLibraryPath("/library");
        });

        expect(reloadSpy).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it("logs and reports an error when preparing settings fails", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();
        const error = new Error("load failed");

        vi.mocked(loadStoredSettings).mockRejectedValueOnce(error);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.prepareSettings();
        });

        expect(logError).toHaveBeenCalledWith(
            "settings",
            "Failed to prepare app settings.",
            error
        );
        expect(onError).toHaveBeenCalledWith("Failed to prepare app settings.");
        expect(setSettings).not.toHaveBeenCalled();
        // A failed read leaves the stored preferences unknown, so nothing gated on them may run.
        expect(result.current.hasLoadedSettings).toBe(false);
    });

    const SUMMARY = {
        total_bytes: 2048,
        formatted_size: "2 KB",
        video_files: 3,
        audio_files: 1,
        thumbnail_files: 4,
    };

    async function renderWithPendingMove(
        onError = vi.fn(),
        setSettings = vi.fn(),
        onNotice?: (message: string) => void
    ) {
        vi.mocked(planChangeLibraryPath).mockResolvedValueOnce({
            kind: "move",
            currentLibraryPath: "/library",
            destination: "/new-library",
        });
        vi.mocked(getLibrarySummary).mockResolvedValueOnce(SUMMARY);

        const rendered = await renderLoaded(onError, setSettings, onNotice);

        await act(async () => {
            await rendered.result.current.changeLibraryPath("/library");
        });

        return { ...rendered, onError, setSettings };
    }

    it("asks before moving an existing library, with what is about to be copied", async () => {
        const { result, setSettings } = await renderWithPendingMove();

        expect(planChangeLibraryPath).toHaveBeenCalledWith({ currentLibraryPath: "/library" });
        expect(getLibrarySummary).toHaveBeenCalledWith("/library");
        expect(result.current.pendingLibraryMove).toEqual({
            currentLibraryPath: "/library",
            destination: "/new-library",
            summary: SUMMARY,
            currentFolderUnreachable: false,
        });
        // Nothing moved yet.
        expect(moveLibrary).not.toHaveBeenCalled();
        expect(setSettings).not.toHaveBeenCalled();
    });

    it("still asks when the summary cannot be read", async () => {
        vi.mocked(planChangeLibraryPath).mockResolvedValueOnce({
            kind: "move",
            currentLibraryPath: "/library",
            destination: "/new-library",
        });
        vi.mocked(getLibrarySummary).mockRejectedValueOnce(new Error("unreadable"));

        const { result } = await renderLoaded();

        await act(async () => {
            await result.current.changeLibraryPath("/library");
        });

        expect(result.current.pendingLibraryMove?.summary).toBeNull();
    });

    it("moves the library once confirmed and stores the new path", async () => {
        const { result, onError, setSettings } = await renderWithPendingMove();

        vi.mocked(moveLibrary).mockResolvedValueOnce({
            changed: true,
            finalLibraryPath: "/new-library",
            oldDirectoryRetained: false,
        });
        vi.mocked(updateStoredLibraryPath).mockResolvedValueOnce(NEW_SETTINGS);

        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        expect(moveLibrary).toHaveBeenCalledWith(
            {
                currentLibraryPath: "/library",
                destination: "/new-library",
                summary: SUMMARY,
                currentFolderUnreachable: false,
            },
            expect.any(Function)
        );
        expect(updateStoredLibraryPath).toHaveBeenCalledWith("/new-library");
        expect(setSettings).toHaveBeenCalledWith(NEW_SETTINGS);
        expect(result.current.pendingLibraryMove).toBeNull();
        expect(onError).not.toHaveBeenCalled();
    });

    it("exposes the copy's progress while it runs and asks the backend to stop on cancel", async () => {
        const { result } = await renderWithPendingMove();
        const progress = { copiedFiles: 1, totalFiles: 4, copiedBytes: 512, totalBytes: 2048 };

        let finishMove: (() => void) | undefined;
        vi.mocked(moveLibrary).mockImplementationOnce(
            (_move, onProgress) =>
                new Promise((resolve, reject) => {
                    onProgress?.(progress);
                    finishMove = () =>
                        reject({ code: "LIBRARY_MIGRATION_CANCELLED", message: "cancelled" });
                    void resolve;
                })
        );

        let confirming: Promise<void> | undefined;
        await act(async () => {
            confirming = result.current.confirmLibraryMove();
            await Promise.resolve();
        });

        expect(result.current.libraryMoveProgress).toEqual(progress);

        await act(async () => {
            await result.current.cancelRunningLibraryMove();
        });
        expect(cancelLibraryMigration).toHaveBeenCalledTimes(1);

        await act(async () => {
            finishMove?.();
            await confirming;
        });

        expect(result.current.libraryMoveProgress).toBeNull();
        expect(result.current.pendingLibraryMove).toBeNull();
    });

    it("drops the pending move when the user cancels", async () => {
        const { result } = await renderWithPendingMove();

        act(() => {
            result.current.cancelLibraryMove();
        });

        expect(result.current.pendingLibraryMove).toBeNull();
        expect(moveLibrary).not.toHaveBeenCalled();
    });

    it("asks a second time when the current folder turns out to be unreachable", async () => {
        const { result, onError, setSettings } = await renderWithPendingMove();

        vi.mocked(moveLibrary).mockRejectedValueOnce({
            code: "LIBRARY_FOLDER_UNREACHABLE",
            message: "the current library folder cannot be reached",
        });

        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        expect(result.current.pendingLibraryMove?.currentFolderUnreachable).toBe(true);
        expect(onError).not.toHaveBeenCalled();
        expect(setSettings).not.toHaveBeenCalled();

        vi.mocked(moveLibrary).mockResolvedValueOnce({
            changed: true,
            finalLibraryPath: "/new-library",
            oldDirectoryRetained: false,
        });
        vi.mocked(updateStoredLibraryPath).mockResolvedValueOnce(NEW_SETTINGS);

        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        expect(moveLibrary).toHaveBeenLastCalledWith(
            expect.objectContaining({ currentFolderUnreachable: true }),
            expect.any(Function)
        );
        expect(setSettings).toHaveBeenCalledWith(NEW_SETTINGS);
    });

    it("reports a second unreachable refusal instead of asking forever", async () => {
        const { result, onError } = await renderWithPendingMove();
        const unreachable = {
            code: "LIBRARY_FOLDER_UNREACHABLE",
            message: "the current library folder cannot be reached",
        };

        vi.mocked(moveLibrary).mockRejectedValueOnce(unreachable);
        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        vi.mocked(moveLibrary).mockRejectedValueOnce(unreachable);
        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        expect(onError).toHaveBeenCalledTimes(1);
        expect(result.current.pendingLibraryMove).toBeNull();
    });

    it("warns the user when the migration kept the old library directory", async () => {
        const { result, onError, setSettings } = await renderWithPendingMove();

        vi.mocked(moveLibrary).mockResolvedValueOnce({
            changed: true,
            finalLibraryPath: "/new-library",
            oldDirectoryRetained: true,
        });
        vi.mocked(updateStoredLibraryPath).mockResolvedValueOnce(NEW_SETTINGS);

        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        // The new library is still applied...
        expect(setSettings).toHaveBeenCalled();
        // ...and the user is told a duplicate copy remains in the old folder.
        expect(onError).toHaveBeenCalledWith(
            expect.stringContaining("old folder could not be removed completely")
        );
    });

    it("tells the user to restart when the move finished but its path could not be saved", async () => {
        // The library is in the new folder and the old one may be gone. "Failed to change library
        // folder" sent the user to retry a move that had already happened.
        const { result, onError, setSettings } = await renderWithPendingMove();

        vi.mocked(moveLibrary).mockResolvedValueOnce({
            changed: true,
            finalLibraryPath: "/new-library",
            oldDirectoryRetained: false,
        });
        vi.mocked(updateStoredLibraryPath).mockRejectedValueOnce(new Error("database is busy"));

        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        expect(onError).toHaveBeenCalledWith(expect.stringContaining("Restart Kavynex"));
        expect(onError).not.toHaveBeenCalledWith("Failed to change library folder.");
        expect(setSettings).not.toHaveBeenCalled();
    });

    it("reports a cancelled move as a notice", async () => {
        const onNotice = vi.fn();
        const { result, onError } = await renderWithPendingMove(vi.fn(), vi.fn(), onNotice);

        vi.mocked(moveLibrary).mockRejectedValueOnce({
            code: "LIBRARY_MIGRATION_CANCELLED",
            message: "cancelled",
        });

        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("The move was cancelled"));
        expect(onError).not.toHaveBeenCalled();
    });

    it("logs and reports an error when the move fails", async () => {
        const { result, onError, setSettings } = await renderWithPendingMove();
        const error = new Error("move failed");

        vi.mocked(moveLibrary).mockRejectedValueOnce(error);

        await act(async () => {
            await result.current.confirmLibraryMove();
        });

        expect(logError).toHaveBeenCalledWith("settings", "Failed to change library folder.", error, {
            currentLibraryPath: "/library",
        });
        expect(onError).toHaveBeenCalledWith("Failed to change library folder.");
        expect(setSettings).not.toHaveBeenCalled();
        expect(result.current.pendingLibraryMove).toBeNull();
    });

    it("applies a first library folder without asking", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(planChangeLibraryPath).mockResolvedValueOnce({
            kind: "apply",
            finalLibraryPath: "/new-library",
        });
        vi.mocked(updateStoredLibraryPath).mockResolvedValueOnce(NEW_SETTINGS);

        const { result } = await renderLoaded(onError, setSettings);

        await act(async () => {
            await result.current.changeLibraryPath("");
        });

        expect(setSettings).toHaveBeenCalledWith(NEW_SETTINGS);
        expect(result.current.pendingLibraryMove).toBeNull();
        expect(moveLibrary).not.toHaveBeenCalled();
    });

    it("logs and reports an error when choosing the folder fails", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();
        const error = new Error("change failed");

        vi.mocked(planChangeLibraryPath).mockRejectedValueOnce(error);

        const { result } = await renderLoaded(onError, setSettings);

        await act(async () => {
            await result.current.changeLibraryPath("/library");
        });

        expect(logError).toHaveBeenCalledWith("settings", "Failed to change library folder.", error, {
            currentLibraryPath: "/library",
        });
        expect(onError).toHaveBeenCalledWith("Failed to change library folder.");
        expect(setSettings).not.toHaveBeenCalled();
    });

    it("refuses to change the library folder before the stored settings were read", async () => {
        // A failed read leaves the defaults, with an empty library path. A folder picked then would
        // be stored as a first library over the real one, with nothing moved.
        const onError = vi.fn();

        const { result } = renderHook(() =>
            useAppSettingsActions({ onError, setSettings: vi.fn() })
        );

        await act(async () => {
            await result.current.changeLibraryPath("");
        });

        expect(planChangeLibraryPath).not.toHaveBeenCalled();
        expect(updateStoredLibraryPath).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(expect.stringMatching(/could not read its settings/));
    });

    it("does not update settings when the library path was not changed", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(planChangeLibraryPath).mockResolvedValueOnce({ kind: "unchanged" });

        const { result } = await renderLoaded(onError, setSettings);

        await act(async () => {
            await result.current.changeLibraryPath("/library");
        });

        expect(updateStoredLibraryPath).not.toHaveBeenCalled();
        expect(setSettings).not.toHaveBeenCalled();
        expect(onError).not.toHaveBeenCalled();
        expect(result.current.pendingLibraryMove).toBeNull();
    });

    it("updates import mode in storage", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(updateStoredImportMode).mockResolvedValueOnce({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        act(() => {
            result.current.setImportModeAction("move");
        });

        await waitFor(() => {
            expect(updateStoredImportMode).toHaveBeenCalledWith("move");
        });

        expect(setSettings).toHaveBeenCalledWith({
            importMode: "move",
            libraryPath: "/library",
            loadRemoteImages: true,
            checkUpdatesOnStartup: false,
            externalBackupDir: "",
        });
        expect(onError).not.toHaveBeenCalled();
    });

    it("logs and reports an error when changing the import mode fails", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();
        const error = new Error("mode failed");

        vi.mocked(updateStoredImportMode).mockRejectedValueOnce(error);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        act(() => {
            result.current.setImportModeAction("move");
        });

        await waitFor(() => {
            expect(logError).toHaveBeenCalledWith(
                "settings",
                "Failed to change import mode.",
                error,
                {
                    mode: "move",
                }
            );
        });

        expect(onError).toHaveBeenCalledWith("Failed to change import mode.");
        expect(setSettings).not.toHaveBeenCalled();
    });

    it("opens current library path", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();

        vi.mocked(openLibraryDirectory).mockResolvedValueOnce(undefined);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.openCurrentLibraryPathAction("/library");
        });

        expect(openLibraryDirectory).toHaveBeenCalledWith("/library");
        expect(onError).not.toHaveBeenCalled();
    });

    it("reports open library path error", async () => {
        const onError = vi.fn();
        const setSettings = vi.fn();
        const error = new Error("open failed");

        vi.mocked(openLibraryDirectory).mockRejectedValueOnce(error);

        const { result } = renderHook(() =>
            useAppSettingsActions({
                onError,
                setSettings,
            })
        );

        await act(async () => {
            await result.current.openCurrentLibraryPathAction("/library");
        });

        expect(logError).toHaveBeenCalledWith(
            "settings",
            "Failed to open library folder.",
            error,
            {
                libraryPath: "/library",
            }
        );
        expect(onError).toHaveBeenCalledWith("Failed to open library folder.");
    });

    it("recreates action callbacks when onError or setSettings change", () => {
        const onError1 = vi.fn();
        const setSettings1 = vi.fn();

        const { result, rerender } = renderHook(
            (props: { onError: (message: string) => void; setSettings: typeof setSettings1 }) =>
                useAppSettingsActions(props),
            {
                initialProps: { onError: onError1, setSettings: setSettings1 },
            }
        );

        const firstPrepare = result.current.prepareSettings;
        const firstChange = result.current.changeLibraryPath;
        const firstImportMode = result.current.setImportModeAction;
        const firstOpen = result.current.openCurrentLibraryPathAction;

        const onError2 = vi.fn();
        const setSettings2 = vi.fn();

        rerender({ onError: onError2, setSettings: setSettings2 });

        expect(result.current.prepareSettings).not.toBe(firstPrepare);
        expect(result.current.changeLibraryPath).not.toBe(firstChange);
        expect(result.current.setImportModeAction).not.toBe(firstImportMode);
        expect(result.current.openCurrentLibraryPathAction).not.toBe(firstOpen);
    });

    it("returns a stable controller object across a rerender with unchanged props", () => {
        // The object must keep its identity when nothing it depends on changes. Without the
        // useMemoObject wrap it was a fresh literal every render, which propagated through
        // use-app-settings and defeated the HomeSecondaryModals memo boundary (it re-rendered on
        // every yt-dlp log tick even though no setting had changed).
        const onError = vi.fn();
        const setSettings = vi.fn();

        const { result, rerender } = renderHook(
            (props: { onError: (message: string) => void; setSettings: typeof setSettings }) =>
                useAppSettingsActions(props),
            { initialProps: { onError, setSettings } }
        );

        const first = result.current;

        rerender({ onError, setSettings });

        expect(result.current).toBe(first);
    });
});