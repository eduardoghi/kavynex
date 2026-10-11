import { useCallback, useState } from "react";
import type { DatabaseIntegrityReport } from "../types/generated/DatabaseIntegrityReport";
import { checkDatabaseIntegrity, rebuildDatabaseIndexes } from "../services/database-service";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";
import { useMemoObject } from "./use-memo-object";

// The outcome of a full integrity check as the UI needs it. A healthy result, a healthy result
// right after the indexes were rebuilt, the problems SQLite listed (with whether the list was
// capped and whether a rebuild already ran), or a failure to run the check at all.
export type IntegrityResult =
    | { status: "ok" }
    | { status: "repaired" }
    | { status: "problem"; problems: string[]; truncated: boolean; rebuilt: boolean }
    | { status: "error"; message: string };

type UseDatabaseIntegrityCheckReturn = {
    loading: boolean;
    rebuilding: boolean;
    result: IntegrityResult | null;
    runCheck: () => Promise<void>;
    rebuildIndexes: () => Promise<void>;
};

function toResult(report: DatabaseIntegrityReport, rebuilt: boolean): IntegrityResult {
    if (report.ok) {
        return rebuilt ? { status: "repaired" } : { status: "ok" };
    }

    return {
        status: "problem",
        problems: report.problems,
        truncated: report.truncated,
        rebuilt,
    };
}

// Owns the async run of the (user-triggered) full database integrity check and of the index
// rebuild it offers when the check finds damage, so the component stays presentational and this
// logic is unit-testable on its own, mirroring how every other stateful data flow in the app lives
// in a hook rather than inside a component.
export function useDatabaseIntegrityCheck(): UseDatabaseIntegrityCheckReturn {
    const [loading, setLoading] = useState(false);
    const [rebuilding, setRebuilding] = useState(false);
    const [result, setResult] = useState<IntegrityResult | null>(null);

    const runCheck = useCallback(async (): Promise<void> => {
        setLoading(true);
        setResult(null);

        try {
            setResult(toResult(await checkDatabaseIntegrity(), false));
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

    const rebuildIndexes = useCallback(async (): Promise<void> => {
        setRebuilding(true);

        try {
            setResult(toResult(await rebuildDatabaseIndexes(), true));
        } catch (error) {
            logError("diagnostics", "Failed to rebuild the database indexes.", error);
            setResult({
                status: "error",
                message: resolveErrorMessage(error, "Failed to rebuild the indexes."),
            });
        } finally {
            setRebuilding(false);
        }
    }, []);

    return useMemoObject({ loading, rebuilding, result, runCheck, rebuildIndexes });
}
