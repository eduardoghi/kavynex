import { useCallback } from "react";
import type { DatabaseIntegrityReport } from "../types/generated/DatabaseIntegrityReport";
import { checkDatabaseIntegrity, rebuildDatabaseIndexes } from "../services/database-service";
import { useAsyncFlag } from "./use-async-flag";
import { useMemoObject } from "./use-memo-object";
import { useRunReport, type RunError } from "./use-run-report";

// The outcome of a full integrity check as the UI needs it. A healthy result, a healthy result
// right after the indexes were rebuilt, the problems SQLite listed (with whether the list was
// capped and whether a rebuild already ran), or a failure to run the check at all.
type IntegrityOutcome =
    | { status: "ok" }
    | { status: "repaired" }
    | { status: "problem"; problems: string[]; truncated: boolean; rebuilt: boolean };

export type IntegrityResult = IntegrityOutcome | RunError;

type UseDatabaseIntegrityCheckReturn = {
    loading: boolean;
    rebuilding: boolean;
    result: IntegrityResult | null;
    runCheck: () => Promise<void>;
    rebuildIndexes: () => Promise<void>;
};

function toResult(report: DatabaseIntegrityReport, rebuilt: boolean): IntegrityOutcome {
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
    const { isRunning: loading, runWithFlag: runCheckFlag } = useAsyncFlag();
    const { isRunning: rebuilding, runWithFlag: runRebuildFlag } = useAsyncFlag();
    const { result, run } = useRunReport<IntegrityOutcome>();

    const runCheck = useCallback(async (): Promise<void> => {
        await runCheckFlag(() =>
            run(async () => toResult(await checkDatabaseIntegrity(), false), {
                log: "Failed to run the database integrity check.",
                message: "Failed to run the integrity check.",
            })
        );
    }, [runCheckFlag, run]);

    // The check's result stays on screen while the rebuild runs, since the rebuild is offered from it.
    const rebuildIndexes = useCallback(async (): Promise<void> => {
        await runRebuildFlag(() =>
            run(
                async () => toResult(await rebuildDatabaseIndexes(), true),
                {
                    log: "Failed to rebuild the database indexes.",
                    message: "Failed to rebuild the indexes.",
                },
                true
            )
        );
    }, [runRebuildFlag, run]);

    return useMemoObject({ loading, rebuilding, result, runCheck, rebuildIndexes });
}
