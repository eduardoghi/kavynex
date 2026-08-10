import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagnosticsController } from "../types/controllers";
import { getDiagnosticsSummary } from "../services/diagnostics-service";
import { openLogDirectory as openLogDirectoryInSystem } from "../services/library-service";
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

export function useDiagnostics({
    libraryPath,
    importMode,
    onError,
}: UseDiagnosticsOptions): DiagnosticsController {
    const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
    const [diagnosticsSummary, setDiagnosticsSummary] = useState<DiagnosticsSummary | null>(null);
    const [isLoadingDiagnostics, setIsLoadingDiagnostics] = useState(false);

    const requestGuard = useRequestGuard();
    // Its own flag rather than the shared `isLoadingDiagnostics`, which the Refresh button owns:
    // opening the log folder loads no diagnostics, and reusing that flag would put the Refresh
    // button into a loading state for an action that has nothing to do with it.
    const logDirectoryFlag = useAsyncFlag();
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

    // No request guard, unlike the loaders above: this resolves to nothing and updates no state, so
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
    });
}