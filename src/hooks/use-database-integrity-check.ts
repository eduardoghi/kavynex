import { useCallback, useState } from "react";
import { checkDatabaseIntegrity } from "../services/database-service";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";
import { useMemoObject } from "./use-memo-object";

// The outcome of a full integrity check as the UI needs it: a healthy result, the problems
// SQLite listed (with whether the list was capped), or a failure to run the check at all.
export type IntegrityResult =
    | { status: "ok" }
    | { status: "problem"; problems: string[]; truncated: boolean }
    | { status: "error"; message: string };

type UseDatabaseIntegrityCheckReturn = {
    loading: boolean;
    result: IntegrityResult | null;
    runCheck: () => Promise<void>;
};

// Owns the async run of the (user-triggered) full database integrity check, so the component
// stays presentational and this logic is unit-testable on its own - mirroring how every other
// stateful data flow in the app lives in a hook rather than inside a component.
export function useDatabaseIntegrityCheck(): UseDatabaseIntegrityCheckReturn {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<IntegrityResult | null>(null);

    const runCheck = useCallback(async (): Promise<void> => {
        setLoading(true);
        setResult(null);

        try {
            const report = await checkDatabaseIntegrity();
            setResult(
                report.ok
                    ? { status: "ok" }
                    : {
                          status: "problem",
                          problems: report.problems,
                          truncated: report.truncated,
                      }
            );
        } catch (error) {
            logError("diagnostics", "Failed to run the database integrity check.", error);
            setResult({
                status: "error",
                message: resolveErrorMessage(error, "Failed to run the integrity check."),
            });
        } finally {
            setLoading(false);
        }
    }, []);

    return useMemoObject({ loading, result, runCheck });
}
