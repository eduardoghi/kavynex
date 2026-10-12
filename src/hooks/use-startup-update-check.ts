import { useEffect, useRef } from "react";
import { checkAppUpdate } from "../services/app-update-service";
import { logWarn } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";

type UseStartupUpdateCheckOptions = {
    // Whether to check now. The caller has to keep this false until the stored preference is known
    // (Settings > Application update), because the in-memory default is on and the check runs at
    // most once, on the first render where this is true.
    enabled: boolean;
    // Surfaces a non-intrusive "a new version is available" notice.
    onUpdateAvailable: (message: string) => void;
};

// Runs a single passive update check and shows a non-intrusive notice if a newer version is
// available. It fires at most once per app session (a ref guards against re-runs) and contacts the
// update endpoint only when `enabled` is true. The app's default is on (see
// normalizeCheckUpdatesOnStartup, which owns that rule), so a launch checks unless the user turned
// it off in Settings. This hook holds no opinion about that. It reads the resolved flag.
export function useStartupUpdateCheck({
    enabled,
    onUpdateAvailable,
}: UseStartupUpdateCheckOptions): void {
    const hasCheckedRef = useRef(false);

    useEffect(() => {
        if (!enabled || hasCheckedRef.current) {
            return;
        }

        hasCheckedRef.current = true;

        void (async () => {
            try {
                const update = await checkAppUpdate();

                if (update) {
                    onUpdateAvailable(
                        `Version ${update.version} of Kavynex is available. Open Settings to update.`
                    );
                }
            } catch (error) {
                // A failed passive check must never interrupt startup; log it and stay quiet.
                // Usually no network at startup, which is not a fault of the app.
                logWarn("app-update", "Passive startup update check failed.", {
                    reason: resolveErrorMessage(error, "unknown error"),
                });
            }
        })();
    }, [enabled, onUpdateAvailable]);
}
