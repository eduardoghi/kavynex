import { useCallback, useState } from "react";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";
import { useMemoObject } from "./use-memo-object";

/** A run that could not finish, as the result a Diagnostics check shows in its place. */
export type RunError = { status: "error"; message: string };

/** What to log and what to show when a run throws. */
export type RunFailure = { log: string; message: string };

type UseRunReportReturn<R> = {
    result: R | RunError | null;
    /**
     * Runs `task` and keeps what it returns as the result, or a [`RunError`] when it throws. The
     * previous result is cleared first unless `keepPrevious`, so a re-run does not show a stale one
     * while it works.
     */
    run: (task: () => Promise<R>, failure: RunFailure, keepPrevious?: boolean) => Promise<void>;
};

// The result half of a user-triggered Diagnostics check (the database integrity check and its
// index rebuild, the compaction). The caller pairs it with a `useAsyncFlag` for the busy state, one
// per button, since the integrity check has two buttons writing the one result.
export function useRunReport<R>(): UseRunReportReturn<R> {
    const [result, setResult] = useState<R | RunError | null>(null);

    const run = useCallback(
        async (task: () => Promise<R>, failure: RunFailure, keepPrevious = false): Promise<void> => {
            if (!keepPrevious) {
                setResult(null);
            }

            try {
                setResult(await task());
            } catch (error) {
                logError("diagnostics", failure.log, error);
                setResult({ status: "error", message: resolveErrorMessage(error, failure.message) });
            }
        },
        []
    );

    return useMemoObject({ result, run });
}
