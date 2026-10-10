import { useCallback, useState } from "react";
import { compactDatabase } from "../services/database-service";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";
import { useMemoObject } from "./use-memo-object";

// "nothing" is its own outcome rather than "freed 0 B", so the UI can say there was no space to
// give back instead of reporting a size of zero as if something happened.
export type CompactionResult =
    | { status: "freed"; formattedSize: string }
    | { status: "nothing" }
    | { status: "error"; message: string };

type UseDatabaseCompactionReturn = {
    loading: boolean;
    result: CompactionResult | null;
    runCompaction: () => Promise<void>;
};

// Owns the user-triggered VACUUM, the same split as useDatabaseIntegrityCheck.
export function useDatabaseCompaction(): UseDatabaseCompactionReturn {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<CompactionResult | null>(null);

    const runCompaction = useCallback(async (): Promise<void> => {
        setLoading(true);
        setResult(null);

        try {
            const compaction = await compactDatabase();
            setResult(
                compaction.freedBytes > 0
                    ? { status: "freed", formattedSize: compaction.formattedFreedSize }
                    : { status: "nothing" }
            );
        } catch (error) {
            logError("diagnostics", "Failed to compact the database.", error);
            setResult({
                status: "error",
                message: resolveErrorMessage(error, "Failed to compact the database."),
            });
        } finally {
            setLoading(false);
        }
    }, []);

    return useMemoObject({ loading, result, runCompaction });
}
