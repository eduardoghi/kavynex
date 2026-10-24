import { EVENT_DATABASE_INTEGRITY_FAILED } from "../constants/events";
import { IPC_EVENT_SCHEMAS } from "../lib/ipc-schemas";
import { consumeStartupNotice } from "../services/startup-notices";
import { useStartupNotice } from "./use-startup-notice";

type UseDatabaseIntegrityAlertOptions = {
    // Surfaces the corruption warning to the user (the shared error modal).
    onIntegrityFailure: (message: string) => void;
};

// The user-facing message for a failed background integrity check. Deliberately non-technical and
// action-oriented. The raw PRAGMA problems stay in the log file (and the event payload) for a bug
// report, but the user is told what happened and what to do, not shown the internal diagnostics.
const INTEGRITY_FAILURE_MESSAGE =
    "A routine check found damage in the app database. Your library still opens, but some of it " +
    "may not load correctly. Export a copy from Settings > Database now, then see \"Kavynex " +
    "reports a corrupted database\" in the troubleshooting guide to restore an automatic backup.";

// Surfaces a failed background integrity check. The check runs off the startup critical path and
// only logs on failure. This is what turns that log line into something the user actually sees (a
// banner/modal) instead of having to know to open Settings and run the manual check.
export function useDatabaseIntegrityAlert({
    onIntegrityFailure,
}: UseDatabaseIntegrityAlertOptions): void {
    useStartupNotice({
        event: {
            name: EVENT_DATABASE_INTEGRITY_FAILED,
            schema: IPC_EVENT_SCHEMAS.databaseIntegrityFailed,
        },
        scope: "db-integrity",
        show: () => {
            if (consumeStartupNotice("databaseIntegrityFailed")) {
                onIntegrityFailure(INTEGRITY_FAILURE_MESSAGE);
            }
        },
    });
}
