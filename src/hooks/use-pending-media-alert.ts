import { EVENT_PENDING_MEDIA_ABANDONED } from "../constants/events";
import { IPC_EVENT_SCHEMAS } from "../lib/ipc-schemas";
import { consumeStartupNotice } from "../services/startup-notices";
import { formatCount } from "../utils/pluralize";
import { useStartupNotice } from "./use-startup-notice";

type UsePendingMediaAlertOptions = {
    // Surfaces the notice to the user. A notice and not an error. Nothing is broken and nothing was
    // lost. Some files are simply taking up space with no library entry behind them.
    onArtifactsAbandoned: (message: string) => void;
};

// The user-facing message for artifacts the startup sweep stopped retrying. Written for someone who
// has never heard of a "pending media marker". What it means to them is disk space in use with
// nothing pointing at it, and one place to go about it.
//
// Both next steps exist on that screen. Diagnostics removes the orphan files Kavynex named itself,
// which is what an unfinished import leaves, and shows any one of them in the file manager (see
// use-diagnostics) for a user who wants to look first.
function abandonedMessage(abandoned: number): string {
    return (
        `${formatCount(abandoned, "unfinished media import")} left files in your library that no ` +
        "entry points at, and the app has stopped retrying them automatically. Nothing was lost. " +
        "Open Diagnostics to see which files they are. It can remove them, or show each one in " +
        "your file manager."
    );
}

// Surfaces the media creations the startup sweep gave up on. The sweep reconciles a crashed
// creation on the next launch and retries a failure a few times. Once it gives up, the files stay in
// the library and only a log line records it. This is what turns that into something the user can
// act on, matching how useDatabaseIntegrityAlert treats the background integrity check.
export function usePendingMediaAlert({
    onArtifactsAbandoned,
}: UsePendingMediaAlertOptions): void {
    useStartupNotice({
        event: {
            name: EVENT_PENDING_MEDIA_ABANDONED,
            schema: IPC_EVENT_SCHEMAS.pendingMediaAbandoned,
        },
        scope: "pending-media",
        show: () => {
            const abandoned = consumeStartupNotice("pendingMediaAbandoned");

            // The count comes over IPC, so a zero or negative value must not produce a notice
            // claiming "0 unfinished imports".
            if (abandoned !== null && abandoned >= 1) {
                onArtifactsAbandoned(abandonedMessage(abandoned));
            }
        },
    });
}
