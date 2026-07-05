import { useCallback, useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AppUpdateInfo, AppUpdateProgress } from "../services/app-update-service";
import { exportDatabase, importDatabase } from "../services/database-service";
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
    databaseBusy: "idle" | "exporting" | "importing";
    databaseMessage: DatabaseMessage | null;
    pendingImportPath: string | null;
    exportDatabaseAction: () => Promise<void>;
    pickImportFileAction: () => Promise<void>;
    confirmImportAction: () => Promise<void>;
    cancelImport: () => void;
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

    const [databaseBusy, setDatabaseBusy] = useState<"idle" | "exporting" | "importing">("idle");
    const [databaseMessage, setDatabaseMessage] = useState<DatabaseMessage | null>(null);
    const [pendingImportPath, setPendingImportPath] = useState<string | null>(null);

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
            destination = await save({
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
            selection = await open({
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

    useEffect(() => {
        if (!opened) {
            summaryRequestIdRef.current += 1;
            lastLoadedLibraryPathRef.current = "";
            setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
            setLibrarySummaryError("");
            setIsLoadingLibrarySummary(false);
            return;
        }

        void loadLibrarySummary(libraryPath);
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
        appUpdateStatus,
        updateInfo,
        appUpdateProgress,
        appUpdateErrorMessage,
        checkForUpdate,
        installUpdate,
    };
}
