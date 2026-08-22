import { useEffect } from "react";
import { EVENT_PENDING_MEDIA_ABANDONED } from "../constants/events";
import { IPC_EVENT_SCHEMAS } from "../lib/ipc-schemas";
import { listenValidated } from "../lib/tauri-client";
import { formatCount } from "../utils/pluralize";
import { logError } from "../utils/app-logger";

type UsePendingMediaAlertOptions = {
    // Surfaces the notice to the user. A notice and not an error: nothing is broken and nothing was
    // lost. Some files are simply taking up space with no library entry behind them.
    onArtifactsAbandoned: (message: string) => void;
};

// The user-facing message for artifacts the startup sweep stopped retrying. Written for someone who
// has never heard of a "pending media marker": what it means to them is disk space in use with
// nothing pointing at it, and one place to go about it.
//
// It names the file manager rather than stopping at Diagnostics, because Diagnostics reports and
// never deletes. This used to end with "open Diagnostics to review the unreferenced files and
// remove them", which sent the user to a screen that has no such action and left the real last step
// unwritten. What the screen does offer is the path itself, as a link that shows the file where it
// lives (see the reveal action in use-diagnostics), so the two halves of the instruction are now
// both true and both reachable.
function abandonedMessage(abandoned: number): string {
    return (
        `${formatCount(abandoned, "unfinished media import")} left files in your library that no ` +
        "entry points at, and the app has stopped retrying them automatically. Nothing was lost. " +
        "Open Diagnostics to see which files they are, then click one to show it in your file " +
        "manager and delete it there if you no longer want it."
    );
}

// Subscribes to the backend's pending-media-abandoned event and surfaces it. The startup sweep
// reconciles a crashed media creation on the next launch and retries a failure a few times. Once it
// gives up, the files stay in the library and only a log line records it. This is what turns that
// into something the user can act on, matching how useDatabaseIntegrityAlert treats the background
// integrity check.
export function usePendingMediaAlert({
    onArtifactsAbandoned,
}: UsePendingMediaAlertOptions): void {
    useEffect(() => {
        // StrictMode double-invokes effects. Guard so a late-resolving listener registered by the
        // torn-down first pass is cleaned up rather than leaking.
        let isDisposed = false;
        let unlisten: (() => void) | null = null;

        void (async () => {
            try {
                const stop = await listenValidated(
                    EVENT_PENDING_MEDIA_ABANDONED,
                    IPC_EVENT_SCHEMAS.pendingMediaAbandoned,
                    (payload) => {
                        // The backend only emits with at least one, but the count comes over IPC and
                        // the schema only proves it is a number, so a zero or negative value must
                        // not produce a notice claiming "0 unfinished imports".
                        if (payload.abandoned < 1) {
                            return;
                        }

                        onArtifactsAbandoned(abandonedMessage(payload.abandoned));
                    }
                );

                if (isDisposed) {
                    stop();
                    return;
                }

                unlisten = stop;
            } catch (error) {
                // Failing to subscribe must never affect the app. The sweep's own error-level lines
                // still record every abandoned marker in the log file regardless.
                logError(
                    "pending-media",
                    "Failed to subscribe to the pending-media-abandoned event.",
                    error
                );
            }
        })();

        return () => {
            isDisposed = true;
            unlisten?.();
        };
    }, [onArtifactsAbandoned]);
}
