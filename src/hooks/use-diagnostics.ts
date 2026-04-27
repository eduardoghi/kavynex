import { useCallback, useEffect, useRef, useState } from "react";
import type { DiagnosticsController } from "../types/controllers";
import { getDiagnosticsSummary } from "../services/diagnostics-service";
import type { DiagnosticsSummary } from "../types/diagnostics";
import type { ImportMode } from "../types/settings";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";

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

    const latestRequestIdRef = useRef(0);
    const hasLoadedSinceOpenRef = useRef(false);
    const previousLibraryPathRef = useRef(libraryPath);
    const previousImportModeRef = useRef(importMode);

    const loadDiagnostics = useCallback(async (): Promise<void> => {
        const requestId = ++latestRequestIdRef.current;
        setIsLoadingDiagnostics(true);

        try {
            const summary = await getDiagnosticsSummary({
                libraryPath,
                importMode,
            });

            if (requestId !== latestRequestIdRef.current) {
                return;
            }

            setDiagnosticsSummary(summary);
        } catch (error) {
            if (requestId !== latestRequestIdRef.current) {
                return;
            }

            setDiagnosticsSummary(null);

            logError("diagnostics", "Failed to load diagnostics.", error, {
                libraryPath,
                importMode,
            });
            onError(resolveErrorMessage(error, "Failed to load diagnostics."));
        } finally {
            if (requestId === latestRequestIdRef.current) {
                setIsLoadingDiagnostics(false);
            }
        }
    }, [importMode, libraryPath, onError]);

    const openDiagnostics = useCallback(async (): Promise<void> => {
        setDiagnosticsOpen(true);
        setDiagnosticsSummary(null);
        hasLoadedSinceOpenRef.current = true;
        previousLibraryPathRef.current = libraryPath;
        previousImportModeRef.current = importMode;
        await loadDiagnostics();
    }, [importMode, libraryPath, loadDiagnostics]);

    const closeDiagnostics = useCallback((): void => {
        latestRequestIdRef.current += 1;
        hasLoadedSinceOpenRef.current = false;
        setDiagnosticsOpen(false);
        setIsLoadingDiagnostics(false);
        setDiagnosticsSummary(null);
    }, []);

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

    return {
        diagnosticsOpen,
        setDiagnosticsOpen,
        diagnosticsSummary,
        isLoadingDiagnostics,
        openDiagnostics,
        closeDiagnostics,
        reloadDiagnostics,
    };
}