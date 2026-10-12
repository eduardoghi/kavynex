import { useCallback, useEffect, useRef, useState } from "react";
import { getDiagnosticsSummary } from "../services/diagnostics-service";
import {
    openFileLocation,
    openKeptFolder as openKeptFolderInSystem,
    openLogDirectory as openLogDirectoryInSystem,
    removeOrphanLibraryFiles,
} from "../services/library-service";
import type { DiagnosticsSummary, KeptFolder } from "../types/diagnostics";
import type { ImportMode } from "../types/settings";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
import { useAsyncFlag } from "./use-async-flag";
import { useMemoObject } from "./use-memo-object";
import { useRequestGuard } from "./use-request-guard";

type UseDiagnosticsOptions = {
    libraryPath: string;
    importMode: ImportMode;
    // The configured library folder could not be reached at startup (a drive that is not
    // connected). The report then says so instead of reading the folder as empty.
    isLibraryUnreachable?: boolean;
    onError: (message: string) => void;
};

export type DiagnosticsController = {
    diagnosticsOpen: boolean;
    setDiagnosticsOpen: (value: boolean) => void;
    diagnosticsSummary: DiagnosticsSummary | null;
    isLoadingDiagnostics: boolean;
    openDiagnostics: () => Promise<void>;
    closeDiagnostics: () => void;
    reloadDiagnostics: () => Promise<void>;
    // Reveals the app's log directory in the OS file manager. Lives on this slice because
    // Diagnostics is where a user is sent to gather what a bug report needs, and it is the one
    // action here that touches no diagnostics state. Hence its own in-flight flag rather than
    // sharing `isLoadingDiagnostics`, which the Refresh button owns.
    openLogDirectory: () => Promise<void>;
    isOpeningLogDirectory: boolean;
    // Reveals one of the report's example files in the OS file manager, by its library-relative
    // path. Offered only for the issues whose examples name a file that is on disk (see
    // `examplesAreOnDisk`). A content-addressed name is not something to find by hand.
    //
    // No in-flight flag beside it, unlike `openLogDirectory`. Nothing renders a busy state for a
    // link in a list, so the flag it does use internally exists only to stop a double click from
    // opening two windows.
    revealLibraryPath: (path: string) => Promise<void>;
    // Deletes the orphan files the app recognizes as its own (a file the user put in the library
    // folder is kept), then reloads the report. The one action here that changes the library.
    removeOrphanFiles: () => Promise<void>;
    isRemovingOrphanFiles: boolean;
    // Opens the recovered downloads folder or the library trash, from the issue that reports it.
    openKeptFolder: (folder: KeptFolder) => Promise<void>;
};

export function useDiagnostics({
    libraryPath,
    importMode,
    isLibraryUnreachable = false,
    onError,
}: UseDiagnosticsOptions): DiagnosticsController {
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
    const [diagnosticsSummary, setDiagnosticsSummary] = useState<DiagnosticsSummary | null>(null);
    const [isLoadingDiagnostics, setIsLoadingDiagnostics] = useState(false);

    const requestGuard = useRequestGuard();
    // Its own flag rather than the shared `isLoadingDiagnostics`, which the Refresh button owns.
    // Opening the log folder loads no diagnostics, and reusing that flag would put the Refresh
    // button into a loading state for an action that has nothing to do with it.
    const logDirectoryFlag = useAsyncFlag();
    // Separate from the flag above rather than shared, because the two are different actions and
    // sharing would let the log folder still opening block a file from being revealed. Nothing
    // renders a busy state for this one (its target is a link in a list, not a button), so the
    // flag's whole job here is the re-entry guard inside `runWithFlag`. A double click would
    // otherwise spawn two file-manager windows onto the same file.
    const revealPathFlag = useAsyncFlag();
    const removeOrphansFlag = useAsyncFlag();
    const keptFolderFlag = useAsyncFlag();
    const hasLoadedSinceOpenRef = useRef(false);
    // Bumped by every close, so an action that outlives the dialog can tell it was closed meanwhile.
    const closeCountRef = useRef(0);
    const previousLibraryPathRef = useRef(libraryPath);
    const previousImportModeRef = useRef(importMode);

    const loadDiagnostics = useCallback(async (): Promise<void> => {
        const requestId = requestGuard.begin();
        setIsLoadingDiagnostics(true);

        try {
            const summary = await getDiagnosticsSummary({
                libraryPath,
                importMode,
                isLibraryUnreachable,
            });

            if (!requestGuard.isCurrent(requestId)) {
                return;
            }

            setDiagnosticsSummary(summary);
        } catch (error) {
            if (!requestGuard.isCurrent(requestId)) {
                return;
            }

            setDiagnosticsSummary(null);

            logError("diagnostics", "Failed to load diagnostics.", error, {
                libraryPath,
                importMode,
            });
            onError(resolveErrorMessage(error, "Failed to load diagnostics."));
        } finally {
            if (requestGuard.isCurrent(requestId)) {
                setIsLoadingDiagnostics(false);
            }
        }
    }, [importMode, isLibraryUnreachable, libraryPath, onError, requestGuard]);

    const openDiagnostics = useCallback(async (): Promise<void> => {
        setDiagnosticsOpen(true);
        setDiagnosticsSummary(null);
        hasLoadedSinceOpenRef.current = true;
        previousLibraryPathRef.current = libraryPath;
        previousImportModeRef.current = importMode;
        await loadDiagnostics();
    }, [importMode, libraryPath, loadDiagnostics]);

    const closeDiagnostics = useCallback((): void => {
        requestGuard.invalidate();
        closeCountRef.current += 1;
        hasLoadedSinceOpenRef.current = false;
        setDiagnosticsOpen(false);
        setIsLoadingDiagnostics(false);
        setDiagnosticsSummary(null);
    }, [requestGuard]);

    const reloadDiagnostics = useCallback(async (): Promise<void> => {
        hasLoadedSinceOpenRef.current = true;
        previousLibraryPathRef.current = libraryPath;
        previousImportModeRef.current = importMode;
        await loadDiagnostics();
    }, [importMode, libraryPath, loadDiagnostics]);

    // No request guard, unlike the loaders above. This resolves to nothing and updates no state, so
    // there is no stale response that could overwrite a newer one. The async flag is here to stop a
    // double click spawning two file-manager windows, which is the only way this misbehaves.
    const openLogDirectory = useCallback(async (): Promise<void> => {
        await logDirectoryFlag.runWithFlag(async () => {
            try {
                await openLogDirectoryInSystem();
            } catch (error) {
                logError("diagnostics", "Failed to open the log directory.", error);
                onError(resolveErrorMessage(error, "Failed to open the log folder."));
            }
        });
    }, [logDirectoryFlag, onError]);

    // Reveals one of the report's example files in the OS file manager, given its library-relative
    // path. Only offered for the issues whose paths name a file that is on disk (see
    // ISSUE_CODES_WITH_FILES_ON_DISK in diagnostics-rules.ts); the containment is still enforced on
    // the backend, which resolves the path against the configured library and refuses anything
    // outside it, so this hook passing a path it was handed is not what makes it safe.
    //
    // This is what the Diagnostics report is for once it has told the user which files are
    // unreferenced, when they want to look before deleting anything (or the file is one the removal
    // below keeps). Finding a content-addressed name like `video/9f2c...mp4` by hand is not a step
    // anyone should be asked to take.
    const revealLibraryPath = useCallback(
        async (path: string): Promise<void> => {
            await revealPathFlag.runWithFlag(async () => {
                try {
                    await openFileLocation(path);
                } catch (error) {
                    logError("diagnostics", "Failed to reveal a library file.", error, { path });
                    onError(resolveErrorMessage(error, "Failed to open the file location."));
                }
            });
        },
        [onError, revealPathFlag]
    );

    // Same shape as openLogDirectory. The flag only stops a double click from opening two windows.
    const openKeptFolder = useCallback(
        async (folder: KeptFolder): Promise<void> => {
            await keptFolderFlag.runWithFlag(async () => {
                try {
                    await openKeptFolderInSystem(folder);
                } catch (error) {
                    logError("diagnostics", "Failed to open a kept folder.", error, { folder });
                    onError(resolveErrorMessage(error, "Failed to open the folder."));
                }
            });
        },
        [keptFolderFlag, onError]
    );

    const removeOrphanFiles = useCallback(async (): Promise<void> => {
        const closesBefore = closeCountRef.current;
        const ran = await removeOrphansFlag.runWithFlag(async () => {
            try {
                const report = await removeOrphanLibraryFiles();
                const failed = report.failed_paths.length;

                if (failed > 0) {
                    onError(
                        `${failed} orphan file(s) could not be removed. The log has the details.`
                    );
                }
            } catch (error) {
                logError("diagnostics", "Failed to remove orphan files.", error);
                onError(resolveErrorMessage(error, "Failed to remove the orphan files."));
            }

            return true;
        });

        // The report is stale either way once the removal ran, so it is reloaded even after a
        // failure, which may have removed some of the files. Not once the dialog was closed, though.
        // The load would run with nothing to show it, and its own failure would open the error
        // dialog for a report nobody asked to see.
        if (ran && closeCountRef.current === closesBefore) {
            await loadDiagnostics();
        }
    }, [loadDiagnostics, onError, removeOrphansFlag]);

    useEffect(() => {
        if (!diagnosticsOpen) {
            return;
        }

        if (!hasLoadedSinceOpenRef.current) {
            return;
        }

        const libraryPathChanged = previousLibraryPathRef.current !== libraryPath;
        const importModeChanged = previousImportModeRef.current !== importMode;

        if (!libraryPathChanged && !importModeChanged) {
            return;
        }

        previousLibraryPathRef.current = libraryPath;
        previousImportModeRef.current = importMode;

        void loadDiagnostics();
    }, [diagnosticsOpen, importMode, libraryPath, loadDiagnostics]);

    // Memoized so the controller object keeps a stable identity across renders. Consumers that
    // depend on the whole object stop being invalidated on unrelated re-renders.
    return useMemoObject({
        diagnosticsOpen,
        setDiagnosticsOpen,
        diagnosticsSummary,
        isLoadingDiagnostics,
        openDiagnostics,
        closeDiagnostics,
        reloadDiagnostics,
        openLogDirectory,
        isOpeningLogDirectory: logDirectoryFlag.isRunning,
        revealLibraryPath,
        removeOrphanFiles,
        isRemovingOrphanFiles: removeOrphansFlag.isRunning,
        openKeptFolder,
    });
}