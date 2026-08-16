import { useCallback, useRef, useState } from "react";
import {
    cancelLibraryVerification,
    verifyLibraryContent,
} from "../services/library-service";
import type { ContentVerificationReport } from "../types/generated/ContentVerificationReport";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";
import { useMemoObject } from "./use-memo-object";

// How far a running verification has got. `total` is what the backend counted up front, so the
// caller can render a fraction without being told the denominator separately.
export type VerificationProgress = { checked: number; total: number };

export type VerificationResult =
    | { status: "done"; report: ContentVerificationReport }
    | { status: "error"; message: string };

type UseLibraryVerificationReturn = {
    running: boolean;
    progress: VerificationProgress | null;
    result: VerificationResult | null;
    verify: (libraryPath: string) => Promise<void>;
    cancel: () => Promise<void>;
};

// Owns the run of the (user-triggered) deep library verification, so the component stays
// presentational and this stays unit-testable, matching every other stateful flow in the app.
//
// The cancel is a separate backend call rather than an aborted promise, because the work happens on
// the blocking pool inside one command: dropping the promise here would leave that sweep reading the
// whole library with nobody listening. `cancel` asks it to stop; the run still resolves normally,
// with a report that says it was cancelled.
export function useLibraryVerification(): UseLibraryVerificationReturn {
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<VerificationProgress | null>(null);
    const [result, setResult] = useState<VerificationResult | null>(null);

    // Guards against a second run being started from a double click before `running` has painted.
    // The backend refuses a concurrent run anyway, but that refusal would surface here as an error
    // message about a verification already running, which is a confusing way to report "you clicked
    // twice".
    const inFlightRef = useRef(false);

    const verify = useCallback(async (libraryPath: string): Promise<void> => {
        if (inFlightRef.current) {
            return;
        }

        inFlightRef.current = true;
        setRunning(true);
        setResult(null);
        setProgress({ checked: 0, total: 0 });

        try {
            const report = await verifyLibraryContent(libraryPath, (checked, total) => {
                setProgress({ checked, total });
            });

            setResult({ status: "done", report });
        } catch (error) {
            logError("diagnostics", "Failed to verify the library content.", error);
            setResult({
                status: "error",
                message: resolveErrorMessage(error, "Failed to verify the library."),
            });
        } finally {
            inFlightRef.current = false;
            setRunning(false);
            setProgress(null);
        }
    }, []);

    const cancel = useCallback(async (): Promise<void> => {
        try {
            await cancelLibraryVerification();
        } catch (error) {
            // Nothing to show the user: the run either stops on its own or finishes, and either way
            // the report that lands is what they see. A failed cancel is worth a log line and not an
            // error dialog on top of a check that is still working.
            logError("diagnostics", "Failed to cancel the library verification.", error);
        }
    }, []);

    return useMemoObject({ running, progress, result, verify, cancel });
}
