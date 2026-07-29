import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagnosticsController } from "../types/controllers";
import { getDiagnosticsSummary } from "../services/diagnostics-service";
import type { DiagnosticsSummary } from "../types/diagnostics";
import type { ImportMode } from "../types/settings";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
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
    });
}