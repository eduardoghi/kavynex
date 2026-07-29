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

export type AppUpdateStatus =
    | "idle"
    | "checking"
    | "available"
    | "not-available"
    | "downloading"
    | "installed"
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
            await installAppUpdate(update, setProgress);
            setStatus("installed");
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