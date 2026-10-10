import { useCallback, useEffect, useState } from "react";
import {
    ensureDatabaseReady,
    getDatabaseBackupStatus,
    restoreDatabaseFromBackup,
    startWithEmptyDatabase,
} from "../services/database-service";
import {
    DATABASE_MIGRATION_BLOCKED_ERROR_CODE,
    DATABASE_MISSING_ERROR_CODE,
    DATABASE_SCHEMA_TOO_NEW_ERROR_CODE,
    DATABASE_UNAVAILABLE_ERROR_CODE,
} from "../constants/error-codes";
import { parseAppError } from "../utils/app-error";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
import { useMemoObject } from "./use-memo-object";

const SCHEMA_TOO_NEW_MESSAGE =
    "This library was created by a newer version of Kavynex. Update Kavynex to open it.";

type UseAppBootstrapOptions = {
    onError: (message: string) => void;
};

// Why the recovery dialog opened. A database that would not open is offered a restore. A missing
// one is offered the restore or a fresh start, since opening it would have created an empty
// database whose daily snapshot then rotates the backups out.
export type DatabaseRecoveryReason = "damaged" | "missing";

export type DatabaseRecoveryController = {
    open: boolean;
    reason: DatabaseRecoveryReason;
    backedUpAtMs: number | null;
    isRestoring: boolean;
    restoreFromBackup: () => Promise<void>;
    startEmpty: () => Promise<void>;
    dismiss: () => void;
};

function reloadApp(): void {
    window.location.reload();
}

export function useAppBootstrap({
    onError,
}: UseAppBootstrapOptions): DatabaseRecoveryController {
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState<DatabaseRecoveryReason>("damaged");
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
                // version, not corruption. Offering a backup restore here would wrongly
                // replace a good database with an older snapshot, so surface a clear "update
                // the app" message and skip the recovery flow entirely.
                if (parseAppError(error).code === DATABASE_SCHEMA_TOO_NEW_ERROR_CODE) {
                    onError(SCHEMA_TOO_NEW_MESSAGE);
                    return;
                }

                // The file could not be read at all (another program holding it), which says
                // nothing about its contents. A restore would replace a database that may be
                // perfectly healthy with an older snapshot, so say what to do instead.
                if (parseAppError(error).code === DATABASE_UNAVAILABLE_ERROR_CODE) {
                    onError(resolveErrorMessage(error, "Kavynex could not read its database."));
                    return;
                }

                // The upgrade could not run, usually for lack of disk space, and the database was
                // left as it was. A restore would replace it with an older snapshot that fails the
                // same upgrade, and lose up to a day of changes on the way.
                if (parseAppError(error).code === DATABASE_MIGRATION_BLOCKED_ERROR_CODE) {
                    onError(
                        resolveErrorMessage(error, "Kavynex could not upgrade its database.")
                    );
                    return;
                }

                // The database could not be opened, or is missing with backups beside it. Offer
                // to restore from the last backup if one exists; otherwise surface the raw
                // initialization error.
                try {
                    const status = await getDatabaseBackupStatus();

                    if (!cancelled && status.available) {
                        setReason(
                            parseAppError(error).code === DATABASE_MISSING_ERROR_CODE
                                ? "missing"
                                : "damaged"
                        );
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

    const startEmpty = useCallback(async (): Promise<void> => {
        setIsRestoring(true);

        try {
            await startWithEmptyDatabase();
            reloadApp();
        } catch (error) {
            logError("bootstrap", "Failed to start with an empty database.", error);
            onError(resolveErrorMessage(error, "Failed to create an empty database."));
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
        reason,
        backedUpAtMs,
        isRestoring,
        restoreFromBackup,
        startEmpty,
        dismiss,
    });
}
