import { useCallback, useState } from "react";
import type { Update } from "../lib/tauri-platform";
import { useMemoObject } from "./use-memo-object";
import {
    checkAppUpdate,
    installAppUpdate,
    toAppUpdateInfo,
    type AppUpdateInfo,
    type AppUpdateProgress
} from "../services/app-update-service";
import { logError } from "../utils/app-logger";

// There is deliberately no terminal success state. `installAppUpdate` ends by relaunching, which
// replaces the process on every platform, so nothing observes a status set after it - and on
// Windows the installer can end the process from inside `downloadAndInstall`, before the relaunch is
// even reached. An `"installed"` member existed here and was set on success; it was rendered
// nowhere, and the two places that read this status both behaved *worse* for it in the one window
// where it was reachable: the "Download and install" button sprang back to enabled as though
// nothing had happened, and settings-modal.tsx's `isUpdateInProgress` went false, unlocking the
// modal in the moment before the relaunch - the exact surprise that lock's comment says it exists to
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

    const checkForUpdate = useCallback(async () => {
        setStatus("checking");
        setErrorMessage("");
        setProgress(null);

        try {
            const availableUpdate = await checkAppUpdate();

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

            setUpdate(null);
            setUpdateInfo(null);
            setStatus("error");
            setErrorMessage("Could not check for updates.");
        }
    }, []);

    const installUpdate = useCallback(async () => {
        if (!update) {
            return;
        }

        setStatus("downloading");
        setErrorMessage("");

        try {
            // No status change on success, by design - see AppUpdateStatus above. The status stays
            // "downloading" until the relaunch takes the process with it.
            await installAppUpdate(update, setProgress);
        } catch (error) {
            logError("app-update", "Failed to install app update.", error);

            setStatus("error");
            setErrorMessage("Could not install the update.");
        }
    }, [update]);

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