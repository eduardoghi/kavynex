import { useCallback, useEffect, useRef, useState } from "react";
import { getDiagnosticsSummary } from "../services/diagnostics-service";
import {
    openFileLocation,
    openLogDirectory as openLogDirectoryInSystem,
} from "../services/library-service";
import type { DiagnosticsSummary } from "../types/diagnostics";
import type { ImportMode } from "../types/settings";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
import { useAsyncFlag } from "./use-async-flag";
import { useMemoObject } from "./use-memo-object";
import { useRequestGuard } from "./use-request-guard";

type UseDiagnosticsOptions = {
    libraryPath: string;
    importMode: ImportMode;
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
    // `examplesAreOnDisk`), and it is the step the report deliberately stops short of: Diagnostics
    // reports and never deletes, so the file manager is where the user finishes, and a
    // content-addressed name is not something to find by hand.
    //
    // No in-flight flag beside it, unlike `openLogDirectory`. Nothing renders a busy state for a
    // link in a list, so the flag it does use internally exists only to stop a double click from
    // opening two windows.
    revealLibraryPath: (path: string) => Promise<void>;
};

export function useDiagnostics({
    libraryPath,
    importMode,
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
    const hasLoadedSinceOpenRef = useRef(false);
    const previousLibraryPathRef = useRef(libraryPath);
    const previousImportModeRef = useRef(importMode);

    const loadDiagnostics = useCallback(async (): Promise<void> => {
        const requestId = requestGuard.begin();
        setIsLoadingDiagnostics(true);

        try {
            const summary = await getDiagnosticsSummary({
                libraryPath,
                importMode,
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
    }, [importMode, libraryPath, onError, requestGuard]);

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
    // unreferenced. The report never deletes, by design, so the next step is always the file
    // manager, and finding a content-addressed name like `video/9f2c...mp4` by hand is not a step
    // anyone should be asked to take.
    const revealLibraryPath = useCallback(
        async (path: string): Promise<void> => {
            await revealPathFlag.runWithFlag(async () => {
                try {
                    await openFileLocation(path, libraryPath);
                } catch (error) {
                    logError("diagnostics", "Failed to reveal a library file.", error, { path });
                    onError(resolveErrorMessage(error, "Failed to open the file location."));
                }
            });
        },
        [libraryPath, onError, revealPathFlag]
    );

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
    });
}