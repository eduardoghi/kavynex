import { useCallback, useEffect, useState } from "react";
import {
    ensureDatabaseReady,
    getDatabaseBackupStatus,
    restoreDatabaseFromBackup,
} from "../services/database-service";
import type { DatabaseRecoveryController } from "../types/controllers";
import { DATABASE_SCHEMA_TOO_NEW_ERROR_CODE } from "../constants/error-codes";
import { parseAppError } from "../utils/app-error";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
import { useMemoObject } from "./use-memo-object";

const SCHEMA_TOO_NEW_MESSAGE =
    "This library was created by a newer version of Kavynex. Update Kavynex to open it.";

type UseAppBootstrapOptions = {
    onError: (message: string) => void;
};

function reloadApp(): void {
    window.location.reload();
}

export function useAppBootstrap({
    onError,
}: UseAppBootstrapOptions): DatabaseRecoveryController {
    const [open, setOpen] = useState(false);
    const [backedUpAtMs, setBackedUpAtMs] = useState<number | null>(null);
    const [isRestoring, setIsRestoring] = useState(false);

    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                await ensureDatabaseReady();
            } catch (error) {
                logError("bootstrap", "Failed to initialize app.", error);

                if (cancelled) {
                    return;
                }

                // A database created by a newer build is valid, just unreadable by this
                // version - not corruption. Offering a backup restore here would wrongly
                // replace a good database with an older snapshot, so surface a clear "update
                // the app" message and skip the recovery flow entirely.
                if (parseAppError(error).code === DATABASE_SCHEMA_TOO_NEW_ERROR_CODE) {
                    onError(SCHEMA_TOO_NEW_MESSAGE);
                    return;
                }

                // The database could not be opened. Offer to restore from the last backup
                // if one exists; otherwise surface the raw initialization error.
                try {
                    const status = await getDatabaseBackupStatus();

                    if (!cancelled && status.available) {
                        setBackedUpAtMs(status.backedUpAtMs);
                        setOpen(true);
                        return;
                    }
                } catch (statusError) {
                    logError(
                        "bootstrap",
                        "Failed to read database backup status.",
                        statusError
                    );
                }

                if (!cancelled) {
                    onError(resolveErrorMessage(error, "Failed to initialize app."));
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [onError]);

    const restoreFromBackup = useCallback(async (): Promise<void> => {
        setIsRestoring(true);

        try {
            await restoreDatabaseFromBackup();
            // Reload so the whole app re-initializes against the restored database instead
            // of running on top of the half-loaded state left by the failed startup.
            reloadApp();
        } catch (error) {
            logError("bootstrap", "Failed to restore database from backup.", error);
            onError(
                resolveErrorMessage(error, "Failed to restore the database from backup.")
            );
            setIsRestoring(false);
            setOpen(false);
        }
    }, [onError]);

    const dismiss = useCallback((): void => {
        setOpen(false);
    }, []);

    // Memoized so consumers depending on the whole object identity don't re-render unnecessarily.
    return useMemoObject({
        open,
        backedUpAtMs,
        isRestoring,
        restoreFromBackup,
        dismiss,
    });
}
