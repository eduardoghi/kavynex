import { useCallback, useEffect, useRef, useState } from "react";
import { relaunch } from "../../lib/tauri-platform";
import { pickFile, pickSaveDestination } from "../../services/file-dialog-service";
import type { AppUpdateInfo, AppUpdateProgress } from "../../services/app-update-service";
import {
    exportDatabase,
    getDatabaseBackupStatus,
    getDatabaseImportUndoStatus,
    getExternalBackupStatus,
    importDatabase,
    undoDatabaseImport,
    type DatabaseBackupStatus,
    type ExternalBackupStatus,
} from "../../services/database-service";
import { getLibrarySummary, type LibrarySummaryInfo } from "../../services/library-service";
import { parseAppError } from "../../utils/app-error";
import { resolveErrorMessage } from "../../utils/error-message";
import { logError } from "../../utils/app-logger";
import { useAppUpdate, type AppUpdateStatus } from "../use-app-update";
import { useMemoObject } from "../use-memo-object";
import { useRequestGuard } from "../use-request-guard";

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
    // The configured mirror folder. A change re-reads the mirror's status.
    externalBackupDir?: string;
};

export type SettingsController = {
    librarySummary: LibrarySummaryInfo;
    isLoadingLibrarySummary: boolean;
    librarySummaryError: string;
    refreshLibrarySummary: () => Promise<void>;
    // Null until the status has been read (or when reading it failed), so the UI can stay silent
    // rather than claim a size or a backup date it does not have.
    backupStatus: DatabaseBackupStatus | null;
    // Null until read, or when reading it failed.
    externalBackupStatus: ExternalBackupStatus | null;
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
    externalBackupDir = "",
}: UseSettingsControllerOptions): SettingsController {
    const [librarySummary, setLibrarySummary] = useState<LibrarySummaryInfo>(EMPTY_LIBRARY_SUMMARY);
    const [isLoadingLibrarySummary, setIsLoadingLibrarySummary] = useState(false);
    const [librarySummaryError, setLibrarySummaryError] = useState("");

    const [backupStatus, setBackupStatus] = useState<DatabaseBackupStatus | null>(null);
    const [externalBackupStatus, setExternalBackupStatus] = useState<ExternalBackupStatus | null>(
        null
    );

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

    const summaryGuard = useRequestGuard();
    const lastLoadedLibraryPathRef = useRef("");

    const loadLibrarySummary = useCallback(
        async (targetLibraryPath: string): Promise<void> => {
            const normalizedLibraryPath = targetLibraryPath.trim();
            const requestId = summaryGuard.begin();

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

                if (!summaryGuard.isCurrent(requestId)) {
                    return;
                }

                lastLoadedLibraryPathRef.current = normalizedLibraryPath;
                setLibrarySummary(summary);
            } catch (error) {
                if (!summaryGuard.isCurrent(requestId)) {
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
                if (summaryGuard.isCurrent(requestId)) {
                    setIsLoadingLibrarySummary(false);
                }
            }
        },
        [summaryGuard]
    );

    const refreshLibrarySummary = useCallback(async (): Promise<void> => {
        await loadLibrarySummary(libraryPath);
    }, [libraryPath, loadLibrarySummary]);

    const exportDatabaseAction = useCallback(async (): Promise<void> => {
        setDatabaseMessage(null);

        let destination: string | null;

        try {
            destination = await pickSaveDestination({
                title: "Export database",
                defaultFileName: "kavynex-backup.db",
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
            setDatabaseMessage({
                tone: "error",
                text: resolveErrorMessage(error, "Could not export the database."),
            });
        } finally {
            setDatabaseBusy("idle");
        }
    }, []);

    const pickImportFileAction = useCallback(async (): Promise<void> => {
        setDatabaseMessage(null);

        let selection: string | null;

        try {
            selection = await pickFile({
                title: "Import database",
                filters: [{ name: "Database", extensions: ["db"] }],
            });
        } catch (error) {
            logError("settings-modal", "Failed to open the import dialog.", error);
            setDatabaseMessage({ tone: "error", text: "Could not open the import dialog." });
            return;
        }

        if (selection) {
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
        } catch (error) {
            logError("settings-modal", "Failed to import the database.", error, {
                parsed: parseAppError(error),
            });
            setDatabaseMessage({
                tone: "error",
                text: resolveErrorMessage(error, "Could not import the selected database."),
            });
            setDatabaseBusy("idle");
            setPendingImportPath(null);
            return;
        }

        // The swap is applied on the next startup, so relaunch to complete the import. A relaunch
        // that fails is not a failed import. The database is already staged and goes in whenever
        // the app next starts, so say that rather than reporting the import itself as failed.
        try {
            await relaunch();
        } catch (error) {
            logError("settings-modal", "Failed to relaunch after staging the import.", error);
            setDatabaseMessage({
                tone: "success",
                text: "The database is ready to import. Close and reopen Kavynex to finish.",
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
            return;
        }

        // The revert is applied on the next startup, so relaunch to complete it. A relaunch that
        // fails is not a failed undo. The revert is staged and goes in whenever the app next starts,
        // and reporting it as failed invited a retry that finds nothing left to undo.
        try {
            await relaunch();
        } catch (error) {
            logError("settings-modal", "Failed to relaunch after staging the undo.", error);
            setDatabaseMessage({
                tone: "success",
                text: "The previous database is ready to restore. Close and reopen Kavynex to finish.",
            });
            setDatabaseBusy("idle");
            setIsUndoImportConfirmOpen(false);
        }
    }, []);

    useEffect(() => {
        if (!opened) {
            summaryGuard.invalidate();
            lastLoadedLibraryPathRef.current = "";
            setLibrarySummary(EMPTY_LIBRARY_SUMMARY);
            setLibrarySummaryError("");
            setIsLoadingLibrarySummary(false);
            setCanUndoImport(false);
            setIsUndoImportConfirmOpen(false);
            // A picked-but-unconfirmed import must not outlive the modal. The modal only locks
            // while `databaseBusy` is set, so a pending import (which is idle, waiting on the
            // confirmation) can be dismissed with Esc or a click outside, and this component
            // stays mounted (home-modals only toggles `opened`). Without clearing it, reopening
            // Settings re-shows "Replace the current database?" for the file the user walked
            // away from, out of context and one click from replacing their library.
            setPendingImportPath(null);
            setDatabaseMessage(null);
            setBackupStatus(null);
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

        // When the last automatic snapshot was taken, and how much disk the database plus its
        // snapshots occupy. Read on every open rather than cached. An export or an import in this
        // same dialog changes both, and the periodic backup can land while it is open.
        void (async () => {
            try {
                const status = await getDatabaseBackupStatus();

                if (!cancelled) {
                    setBackupStatus(status);
                }
            } catch (error) {
                // Purely informational, so a failure just leaves the line out rather than
                // surfacing an error next to the export/import actions, which still work.
                logError("settings-modal", "Failed to read database backup status.", error);

                if (!cancelled) {
                    setBackupStatus(null);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [opened, libraryPath, loadLibrarySummary, summaryGuard]);

    // Whether the mirror's folder is there and when it last copied. Read on open and whenever the
    // folder changes, since choosing a new one makes the old answer wrong.
    useEffect(() => {
        if (!opened) {
            return;
        }

        let cancelled = false;

        void (async () => {
            try {
                const status = await getExternalBackupStatus();

                if (!cancelled) {
                    setExternalBackupStatus(status);
                }
            } catch (error) {
                logError("settings-modal", "Failed to read the external backup status.", error);

                if (!cancelled) {
                    setExternalBackupStatus(null);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [opened, externalBackupDir]);

    // Memoized for a stable identity across renders, matching every sibling controller hook. Not
    // load-bearing today (settings-modal destructures individual fields), but it keeps this hook
    // consistent with the others and safe to pass whole to a memoized consumer later.
    return useMemoObject({
        librarySummary,
        isLoadingLibrarySummary,
        librarySummaryError,
        refreshLibrarySummary,
        backupStatus,
        externalBackupStatus,
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
    });
}
