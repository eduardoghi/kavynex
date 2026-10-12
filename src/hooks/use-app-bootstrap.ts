import { useCallback, useEffect, useRef, useState } from "react";
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

// Where the startup database check stands. "failed" covers every outcome that reported something
// to the user, the recovery dialog included.
export type DatabaseStatus = "pending" | "ready" | "failed";

export type DatabaseRecoveryController = {
    databaseStatus: DatabaseStatus;
    open: boolean;
    reason: DatabaseRecoveryReason;
    backedUpAtMs: number | null;
    isRestoring: boolean;
    // Starting empty is asked a second time. The dialog opens at launch, when a key pressed for
    // something else can land on it, and the backups stop being restorable from here once it runs.
    confirmingStartEmpty: boolean;
    restoreFromBackup: () => Promise<void>;
    askToStartEmpty: () => void;
    cancelStartEmpty: () => void;
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
    const [confirmingStartEmpty, setConfirmingStartEmpty] = useState(false);
    const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus>("pending");

    useEffect(() => {
        let cancelled = false;
        let ready = false;

        void (async () => {
            try {
                await ensureDatabaseReady();
                ready = true;
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
        })().finally(() => {
            // Set once the outcome has been reported, whichever it was, so what the startup error
            // gate drops on a failure is never shown ahead of the message that explains it.
            if (!cancelled) {
                setDatabaseStatus(ready ? "ready" : "failed");
            }
        });

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
            // The dialog stays, so the restore can be tried again (a snapshot another program held
            // is refused rather than passed over) without restarting the app.
            setIsRestoring(false);
        }
    }, [onError]);

    const askToStartEmpty = useCallback((): void => {
        setConfirmingStartEmpty(true);
    }, []);

    const cancelStartEmpty = useCallback((): void => {
        setConfirmingStartEmpty(false);
    }, []);

    const startEmpty = useCallback(async (): Promise<void> => {
        setIsRestoring(true);

        try {
            await startWithEmptyDatabase();
            reloadApp();
        } catch (error) {
            logError("bootstrap", "Failed to start with an empty database.", error);
            onError(resolveErrorMessage(error, "Failed to create an empty database."));
            setIsRestoring(false);
            setConfirmingStartEmpty(false);
        }
    }, [onError]);

    const dismiss = useCallback((): void => {
        setOpen(false);
    }, []);

    // Memoized so consumers depending on the whole object identity don't re-render unnecessarily.
    return useMemoObject({
        databaseStatus,
        open,
        reason,
        backedUpAtMs,
        isRestoring,
        confirmingStartEmpty,
        restoreFromBackup,
        askToStartEmpty,
        cancelStartEmpty,
        startEmpty,
        dismiss,
    });
}

/**
 * Wraps `onError` for the loads that start beside the database check (channels, settings), which
 * fail too when the database does not open, each with its own message.
 *
 * Errors reported while the check is pending are held. They are shown once it succeeds, and dropped
 * when it fails, since the bootstrap's own message or the recovery dialog already says what is
 * wrong, and the callers log every one of them. Once the check settles, errors pass straight through.
 */
export function useStartupErrorGate(
    onError: (message: string) => void,
    databaseStatus: DatabaseStatus
): (message: string) => void {
    // Written during render, so an error reported by an effect of the commit that settled the check
    // already passes through instead of being held behind a flush that has run.
    const statusRef = useRef(databaseStatus);
    statusRef.current = databaseStatus;
    const heldRef = useRef<string[]>([]);

    useEffect(() => {
        if (databaseStatus === "pending") {
            return;
        }

        const held = heldRef.current;
        heldRef.current = [];

        if (databaseStatus === "ready") {
            held.forEach((message) => onError(message));
        }
    }, [databaseStatus, onError]);

    return useCallback(
        (message: string): void => {
            if (statusRef.current === "pending") {
                heldRef.current.push(message);
                return;
            }

            onError(message);
        },
        [onError]
    );
}
