import { useEffect } from "react";
import { EVENT_DATABASE_INTEGRITY_FAILED } from "../constants/events";
import { IPC_EVENT_SCHEMAS } from "../lib/ipc-schemas";
import { listenValidated } from "../lib/tauri-client";
import { logError } from "../utils/app-logger";

type UseDatabaseIntegrityAlertOptions = {
    // Surfaces the corruption warning to the user (the shared error modal).
    onIntegrityFailure: (message: string) => void;
};

// The user-facing message for a failed background integrity check. Deliberately non-technical and
// action-oriented. The raw PRAGMA problems stay in the log file (and the event payload) for a bug
// report, but the user is told what happened and what to do, not shown the internal diagnostics.
const INTEGRITY_FAILURE_MESSAGE =
    "A routine check found that the app database may be corrupted. Open Settings > Database to " +
    "restore from a backup. Until then, some of your library may not load correctly.";

// Subscribes to the backend's database-integrity-failed event and surfaces it to the user. The
// background full integrity check runs off the startup critical path and only logs on failure; this
// is what turns that log line into something the user actually sees (a banner/modal) instead of
// having to know to open Settings and run the manual check.
export function useDatabaseIntegrityAlert({
    onIntegrityFailure,
}: UseDatabaseIntegrityAlertOptions): void {
    useEffect(() => {
        // StrictMode double-invokes effects; guard so a late-resolving listener registered by the
        // torn-down first pass is cleaned up rather than leaking.
        let isDisposed = false;
        let unlisten: (() => void) | null = null;

        void (async () => {
            try {
                const stop = await listenValidated(
                    EVENT_DATABASE_INTEGRITY_FAILED,
                    IPC_EVENT_SCHEMAS.databaseIntegrityFailed,
                    () => {
                        onIntegrityFailure(INTEGRITY_FAILURE_MESSAGE);
                    }
                );

                if (isDisposed) {
                    stop();
                    return;
                }

                unlisten = stop;
            } catch (error) {
                // Failing to subscribe must never affect the app; the failure still reaches the log
                // file on the backend regardless.
                logError("db-integrity", "Failed to subscribe to the integrity-failed event.", error);
            }
        })();

        return () => {
            isDisposed = true;
            unlisten?.();
        };
    }, [onIntegrityFailure]);
}
