import { useCallback } from "react";
import { compactDatabase } from "../services/database-service";
import { useAsyncFlag } from "./use-async-flag";
import { useMemoObject } from "./use-memo-object";
import { useRunReport, type RunError } from "./use-run-report";

// "nothing" is its own outcome rather than "freed 0 B", so the UI can say there was no space to
// give back instead of reporting a size of zero as if something happened.
type CompactionOutcome = { status: "freed"; formattedSize: string } | { status: "nothing" };

export type CompactionResult = CompactionOutcome | RunError;

type UseDatabaseCompactionReturn = {
    loading: boolean;
    result: CompactionResult | null;
    runCompaction: () => Promise<void>;
};

// Owns the user-triggered VACUUM, the same split as useDatabaseIntegrityCheck.
export function useDatabaseCompaction(): UseDatabaseCompactionReturn {
    const { isRunning: loading, runWithFlag } = useAsyncFlag();
    const { result, run } = useRunReport<CompactionOutcome>();

    const runCompaction = useCallback(async (): Promise<void> => {
        await runWithFlag(() =>
            run(
                async () => {
                    const compaction = await compactDatabase();

                    return compaction.freedBytes > 0
                        ? { status: "freed", formattedSize: compaction.formattedFreedSize }
                        : { status: "nothing" };
                },
                {
                    log: "Failed to compact the database.",
                    message: "Failed to compact the database.",
                }
            )
        );
    }, [runWithFlag, run]);

    return useMemoObject({ loading, result, runCompaction });
}
