import { useCallback, useEffect, useState } from "react";
import { EVENT_CLOSE_REQUESTED_WHILE_BUSY } from "../constants/events";
import { IPC_EVENT_SCHEMAS } from "../lib/ipc-schemas";
import { listenValidated } from "../lib/tauri-client";
import { closeAppAnyway } from "../services/app-update-service";
import type { WorkInProgress } from "../types/generated/WorkInProgress";
import { logError } from "../utils/app-logger";
import { useMemoObject } from "./use-memo-object";

type UseCloseGuardReturn = {
    // What the held close would stop, or null when no close is waiting for an answer.
    pending: WorkInProgress | null;
    keepRunning: () => void;
    closeAnyway: () => Promise<void>;
};

// Answers a close the backend held because work a close stops is running (see
// src-tauri/src/services/app_close.rs). Keeping it running drops the question. Closing anyway asks
// the backend to close without asking again.
export function useCloseGuard(): UseCloseGuardReturn {
    const [pending, setPending] = useState<WorkInProgress | null>(null);

    useEffect(() => {
        let isDisposed = false;
        let unlisten: (() => void) | null = null;

        void (async () => {
            try {
                const stop = await listenValidated(
                    EVENT_CLOSE_REQUESTED_WHILE_BUSY,
                    IPC_EVENT_SCHEMAS.closeRequestedWhileBusy,
                    setPending
                );

                if (isDisposed) {
                    stop();
                    return;
                }

                unlisten = stop;
            } catch (error) {
                logError("close-guard", "Failed to listen for a held close.", error);
            }
        })();

        return () => {
            isDisposed = true;
            unlisten?.();
        };
    }, []);

    const keepRunning = useCallback(() => setPending(null), []);

    const closeAnyway = useCallback(async (): Promise<void> => {
        try {
            await closeAppAnyway();
        } catch (error) {
            logError("close-guard", "Failed to close the window.", error);
            setPending(null);
        }
    }, []);

    return useMemoObject({ pending, keepRunning, closeAnyway });
}
