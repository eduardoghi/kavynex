import { useCallback, useEffect, useRef, useState } from "react";
import { openFileDialog, relaunch, saveFileDialog } from "../lib/tauri-platform";
import type { AppUpdateInfo, AppUpdateProgress } from "../services/app-update-service";
import {
    exportDatabase,
    getDatabaseImportUndoStatus,
    importDatabase,
    undoDatabaseImport,
} from "../services/database-service";
import { getLibrarySummary, type LibrarySummaryInfo } from "../services/library-service";
import { parseAppError } from "../utils/app-error";
import { logError } from "../utils/app-logger";
import { useAppUpdate, type AppUpdateStatus } from "./use-app-update";

const EMPTY_LIBRARY_SUMMARY: LibrarySummaryInfo = {
    total_bytes: 0,
    formatted_size: "0 B",
    video_files: 0,
    audio_files: 0,
    thumbnail_files: 0,
};

type DatabaseMessage = {
    tone: "success" | "error";
    text: string;
};

type UseSettingsControllerOptions = {
    opened: boolean;
    libraryPath: string;
};

export type SettingsController = {
    librarySummary: LibrarySummaryInfo;
    isLoadingLibrarySummary: boolean;
    librarySummaryError: string;
    refreshLibrarySummary: () => Promise<void>;
    databaseBusy: "idle" | "exporting" | "importing" | "undoing";
    databaseMessage: DatabaseMessage | null;
    pendingImportPath: string | null;
    exportDatabaseAction: () => Promise<void>;
    pickImportFileAction: () => Promise<void>;
    confirmImportAction: () => Promise<void>;
    cancelImport: () => void;
    canUndoImport: boolean;
    isUndoImportConfirmOpen: boolean;
    requestUndoImport: () => void;
    cancelUndoImport: () => void;
    confirmUndoImportAction: () => Promise<void>;
    appUpdateStatus: AppUpdateStatus;
    updateInfo: AppUpdateInfo | null;
    appUpdateProgress: AppUpdateProgress | null;
    appUpdateErrorMessage: string;
    checkForUpdate: () => Promise<void>;
    installUpdate: () => Promise<void>;
};

export function useSettingsController({
    opened,
    libraryPath,
}: UseSettingsControllerOptions): SettingsController {
    const [librarySummary, setLibrarySummary] = useState<LibrarySummaryInfo>(EMPTY_LIBRARY_SUMMARY);
    const [isLoadingLibrarySummary, setIsLoadingLibrarySummary] = useState(false);
    const [librarySummaryError, setLibrarySummaryError] = useState("");

    const [databaseBusy, setDatabaseBusy] = useState<
        "idle" | "exporting" | "importing" | "undoing"
    >("idle");
    const [databaseMessage, setDatabaseMessage] = useState<DatabaseMessage | null>(null);
    const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);
    const [canUndoImport, setCanUndoImport] = useState(false);
    const [isUndoImportConfirmOpen, setIsUndoImportConfirmOpen] = useState(false);

    const {
        status: appUpdateStatus,
        updateInfo,
        progress: appUpdateProgress,
        errorMessage: appUpdateErrorMessage,
        checkForUpdate,
        installUpdate,
    } = useAppUpdate();

    const summaryRequestIdRef = useRef(0);
    const lastLoadedLibraryPathRef = useRef("");

    const loadLibrarySummary = useCallback(
        async (targetLibraryPath: string): Promise<void> => {
            const normalizedLibraryPath = targetLibraryPath.trim();
            const requestId = ++summaryRequestIdRef.current;

            if (!normalizedLibraryPath) {
                lastLoadedLibraryPathRef.current = "";
                setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
                setLibrarySummaryError("");
                setIsLoadingLibrarySummary(false);
                return;
            }

            if (lastLoadedLibraryPathRef.current !== normalizedLibraryPath) {
                setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
            }

            setIsLoadingLibrarySummary(true);
            setLibrarySummaryError("");

            try {
                const summary = await getLibrarySummary(normalizedLibraryPath);

                if (requestId !== summaryRequestIdRef.current) {
                    return;
                }

                lastLoadedLibraryPathRef.current = normalizedLibraryPath;
                setLibrarySummary(summary);
            } catch (error) {
                if (requestId !== summaryRequestIdRef.current) {
                    return;
                }

                lastLoadedLibraryPathRef.current = "";
                logError("settings-modal", "Failed to load library summary.", error, {
                    libraryPath: normalizedLibraryPath,
                    parsed: parseAppError(error),
                });
                setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
                setLibrarySummaryError("Could not load library summary.");
            } finally {
                if (requestId === summaryRequestIdRef.current) {
                    setIsLoadingLibrarySummary(false);
                }
            }
        },
        []
    );

    const refreshLibrarySummary = useCallback(async (): Promise<void> => {
        await loadLibrarySummary(libraryPath);
    }, [libraryPath, loadLibrarySummary]);

    const exportDatabaseAction = useCallback(async (): Promise<void> => {
        setDatabaseMessage(null);

        let destination: string | null;

        try {
            destination = await saveFileDialog({
                title: "Export database",
                defaultPath: "kavynex-backup.db",
                filters: [{ name: "Database", extensions: ["db"] }],
            });
        } catch (error) {
            logError("settings-modal", "Failed to open the export dialog.", error);
            setDatabaseMessage({ tone: "error", text: "Could not open the export dialog." });
            return;
        }

        if (!destination) {
            return;
        }

        setDatabaseBusy("exporting");

        try {
            await exportDatabase(destination);
            setDatabaseMessage({ tone: "success", text: "Database exported successfully." });
        } catch (error) {
            logError("settings-modal", "Failed to export the database.", error, {
                parsed: parseAppError(error),
            });
            setDatabaseMessage({ tone: "error", text: "Could not export the database." });
        } finally {
            setDatabaseBusy("idle");
        }
    }, []);

    const pickImportFileAction = useCallback(async (): Promise<void> => {
        setDatabaseMessage(null);

        let selection: string | string[] | null;

        try {
            selection = await openFileDialog({
                title: "Import database",
                multiple: false,
                directory: false,
                filters: [{ name: "Database", extensions: ["db"] }],
            });
        } catch (error) {
            logError("settings-modal", "Failed to open the import dialog.", error);
            setDatabaseMessage({ tone: "error", text: "Could not open the import dialog." });
            return;
        }

        if (typeof selection === "string") {
            setPendingImportPath(selection);
        }
    }, []);

    const confirmImportAction = useCallback(async (): Promise<void> => {
        if (!pendingImportPath) {
            return;
        }

        setDatabaseBusy("importing");
        setDatabaseMessage(null);

        try {
            await importDatabase(pendingImportPath);
            // The swap is applied on the next startup, so relaunch to complete the import.
            await relaunch();
        } catch (error) {
            logError("settings-modal", "Failed to import the database.", error, {
                parsed: parseAppError(error),
            });
            setDatabaseMessage({
                tone: "error",
                text: "Could not import the selected database.",
            });
            setDatabaseBusy("idle");
            setPendingImportPath(null);
        }
    }, [pendingImportPath]);

    const cancelImport = useCallback((): void => {
        setPendingImportPath(null);
    }, []);

    const requestUndoImport = useCallback((): void => {
        setDatabaseMessage(null);
        setIsUndoImportConfirmOpen(true);
    }, []);

    const cancelUndoImport = useCallback((): void => {
        setIsUndoImportConfirmOpen(false);
    }, []);

    const confirmUndoImportAction = useCallback(async (): Promise<void> => {
        setDatabaseBusy("undoing");
        setDatabaseMessage(null);

        try {
            await undoDatabaseImport();
            // The revert is applied on the next startup, so relaunch to complete it.
            await relaunch();
        } catch (error) {
            logError("settings-modal", "Failed to undo the last database import.", error, {
                parsed: parseAppError(error),
            });
            setDatabaseMessage({
                tone: "error",
                text: "Could not undo the last database import.",
            });
            setDatabaseBusy("idle");
            setIsUndoImportConfirmOpen(false);
        }
    }, []);

    useEffect(() => {
        if (!opened) {
            summaryRequestIdRef.current += 1;
            lastLoadedLibraryPathRef.current = "";
            setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
            setLibrarySummaryError("");
            setIsLoadingLibrarySummary(false);
            setCanUndoImport(false);
            setIsUndoImportConfirmOpen(false);
            // A picked-but-unconfirmed import must not outlive the modal. The modal only locks
            // while `databaseBusy` is set, so a pending import - which is idle, waiting on the
            // confirmation - can be dismissed with Esc or a click outside, and this component
            // stays mounted (home-modals only toggles `opened`). Without clearing it, reopening
            // Settings re-shows "Replace the current database?" for the file the user walked
            // away from, out of context and one click from replacing their library.
            setPendingImportPath(null);
            setDatabaseMessage(null);
            return;
        }

        void loadLibrarySummary(libraryPath);

        // Whether the last applied import can still be reverted, so the UI can offer it.
        let cancelled = false;
        void (async () => {
            try {
                const available = await getDatabaseImportUndoStatus();

                if (!cancelled) {
                    setCanUndoImport(available);
                }
            } catch (error) {
                logError(
                    "settings-modal",
                    "Failed to read database import undo status.",
                    error
                );

                if (!cancelled) {
                    setCanUndoImport(false);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [opened, libraryPath, loadLibrarySummary]);

    return {
        librarySummary,
        isLoadingLibrarySummary,
        librarySummaryError,
        refreshLibrarySummary,
        databaseBusy,
        databaseMessage,
        pendingImportPath,
        exportDatabaseAction,
        pickImportFileAction,
        confirmImportAction,
        cancelImport,
        canUndoImport,
        isUndoImportConfirmOpen,
        requestUndoImport,
        cancelUndoImport,
        confirmUndoImportAction,
        appUpdateStatus,
        updateInfo,
        appUpdateProgress,
        appUpdateErrorMessage,
        checkForUpdate,
        installUpdate,
    };
}
