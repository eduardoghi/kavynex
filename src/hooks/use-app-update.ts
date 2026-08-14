import { useCallback, useState } from "react";
import type { Update } from "../lib/tauri-platform";
import { useMemoObject } from "./use-memo-object";
import { useRequestGuard } from "./use-request-guard";
import {
    checkAppUpdate,
    installAppUpdate,
    toAppUpdateInfo,
    type AppUpdateInfo,
    type AppUpdateProgress
} from "../services/app-update-service";
import { logError } from "../utils/app-logger";

// There is deliberately no terminal success state. `installAppUpdate` ends by relaunching, which
// replaces the process on every platform, so nothing observes a status set after it, and on
// Windows the installer can end the process from inside `downloadAndInstall`, before the relaunch is
// even reached. An `"installed"` member existed here and was set on success; it was rendered
// nowhere, and the two places that read this status both behaved *worse* for it in the one window
// where it was reachable: the "Download and install" button sprang back to enabled as though
// nothing had happened, and settings-modal.tsx's `isUpdateInProgress` went false, unlocking the
// modal in the moment before the relaunch. The exact surprise that lock's comment says it exists to
// prevent. Staying on "downloading" until the process is gone is what both of them want.
export type AppUpdateStatus =
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "error";

export type UseAppUpdateReturn = {
    status: AppUpdateStatus;
    updateInfo: AppUpdateInfo | null;
    progress: AppUpdateProgress | null;
    errorMessage: string;
    checkForUpdate: () => Promise<void>;
    installUpdate: () => Promise<void>;
};

export function useAppUpdate(): UseAppUpdateReturn {
    const [status, setStatus] = useState<AppUpdateStatus>("idle");
    const [update, setUpdate] = useState<Update | null>(null);
    const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
    const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
    const [errorMessage, setErrorMessage] = useState("");

    // Latest-wins over the update check, which is a network call with a 30s timeout
    // (app-update-service.ts). The Settings button disables itself while a check runs, but that is a
    // promise about Mantine having re-rendered before the next click lands rather than about state,
    // and it says nothing at all about the second reader of this hook: useStartupUpdateCheck fires
    // its own check on launch, so an opt-in startup check and a user clicking "Check update" can
    // genuinely overlap. Without this, whichever resolves last wins, which for a startup check that
    // hangs near its timeout means a stale answer landing on top of the one the user asked for.
    const checkGuard = useRequestGuard();

    const checkForUpdate = useCallback(async () => {
        const requestId = checkGuard.begin();

        setStatus("checking");
        setErrorMessage("");
        setProgress(null);

        try {
            const availableUpdate = await checkAppUpdate();

            if (!checkGuard.isCurrent(requestId)) {
                return;
            }

            if (!availableUpdate) {
                setUpdate(null);
                setUpdateInfo(null);
                setStatus("not-available");
                return;
            }

            setUpdate(availableUpdate);
            setUpdateInfo(toAppUpdateInfo(availableUpdate));
            setStatus("available");
        } catch (error) {
            logError("app-update", "Failed to check app update.", error);

            // Logged regardless (a failure is worth recording whichever request it belonged to) but
            // only surfaced when it is still the current one, so a superseded check cannot replace a
            // newer result with an error the user never asked about.
            if (!checkGuard.isCurrent(requestId)) {
                return;
            }

            setUpdate(null);
            setUpdateInfo(null);
            setStatus("error");
            setErrorMessage("Could not check for updates.");
        }
    }, [checkGuard]);

    const installUpdate = useCallback(async () => {
        if (!update) {
            return;
        }

        // Discards any check still in flight. This is the case the guard matters most for: the
        // status is about to become "downloading" and stay there until the relaunch takes the
        // process (see AppUpdateStatus above), and a check landing afterwards would move it back to
        // "available"/"not-available"/"error". Unlocking the settings modal and re-enabling the
        // install button in the middle of an install.
        checkGuard.invalidate();

        setStatus("downloading");
        setErrorMessage("");

        try {
            // No status change on success, by design. See AppUpdateStatus above. The status stays
            // "downloading" until the relaunch takes the process with it.
            await installAppUpdate(update, setProgress);
        } catch (error) {
            logError("app-update", "Failed to install app update.", error);

            setStatus("error");
            setErrorMessage("Could not install the update.");
        }
        // `checkGuard` is reference-stable (useRequestGuard memoizes over three stable callbacks),
        // so listing it keeps the deps honest without costing this callback its identity. `update`
        // is still the only thing that recreates it.
    }, [update, checkGuard]);

    // Reference-stable so the controller keeps the shared convention (see use-memo-object): a
    // consumer that depends on the whole object does not churn on every render.
    return useMemoObject({
        status,
        updateInfo,
        progress,
        errorMessage,
        checkForUpdate,
        installUpdate
    });
}