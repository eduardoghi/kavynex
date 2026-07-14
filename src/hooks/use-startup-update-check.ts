import { useEffect, useRef } from "react";
import { checkAppUpdate } from "../services/app-update-service";
import { logError } from "../utils/app-logger";

type UseStartupUpdateCheckOptions = {
    // Whether the user opted in (Settings > Application update). Starts false until settings load,
    // so the check never runs before the stored preference is known.
    enabled: boolean;
    // Surfaces a non-intrusive "a new version is available" notice.
    onUpdateAvailable: (message: string) => void;
};

// Runs a single passive update check once the user has opted in, and shows a non-intrusive notice
// if a newer version is available. It fires at most once per app session (a ref guards against
// re-runs) and contacts the update endpoint only when `enabled` is true - the app's default is
// off, so a launch makes no update request unless the user turned this on.
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
                logError("app-update", "Passive startup update check failed.", error);
            }
        })();
    }, [enabled, onUpdateAvailable]);
}
