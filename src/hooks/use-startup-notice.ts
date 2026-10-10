import { useEffect, useRef } from "react";
import type { z } from "zod";
import { listenValidated } from "../lib/tauri-client";
import { pullStartupNotices } from "../services/startup-notices";
import { logError } from "../utils/app-logger";

type UseStartupNoticeOptions<TSchema extends z.ZodTypeAny> = {
    // The event that announces a new finding. Absent for a finding recorded before the window
    // exists, which only the take on mount can reach.
    event?: { name: string; schema: TSchema };
    // Consumes this hook's notices from the held set and shows them. Called after each pull.
    show: () => void;
    scope: string;
};

// Pulls the backend's startup notices once on mount and again whenever `event` fires, then lets
// `show` consume its own. The event alone was not enough. It reaches only a listener that is already
// attached, so a finding announced before the window loaded, or while it reloaded, was lost.
export function useStartupNotice<TSchema extends z.ZodTypeAny>({
    event,
    show,
    scope,
}: UseStartupNoticeOptions<TSchema>): void {
    // Read through a ref so a new `show` identity does not re-run the pull and re-subscribe.
    const showRef = useRef(show);
    showRef.current = show;

    const eventName = event?.name;
    const eventSchema = event?.schema;

    useEffect(() => {
        // StrictMode double-invokes effects. Guard so a late-resolving listener registered by the
        // torn-down first pass is cleaned up rather than leaking.
        let isDisposed = false;
        let unlisten: (() => void) | null = null;

        const pullAndShow = async (): Promise<void> => {
            try {
                await pullStartupNotices();
            } catch (error) {
                logError(scope, "Failed to take the startup notices.", error);
                return;
            }

            if (!isDisposed) {
                showRef.current();
            }
        };

        void pullAndShow();

        if (eventName && eventSchema) {
            void (async () => {
                try {
                    const stop = await listenValidated(eventName, eventSchema, () => {
                        void pullAndShow();
                    });

                    if (isDisposed) {
                        stop();
                        return;
                    }

                    unlisten = stop;
                } catch (error) {
                    // Failing to subscribe must never affect the app. The take on mount and the
                    // backend's log still have the finding.
                    logError(scope, `Failed to subscribe to ${eventName}.`, error);
                }
            })();
        }

        return () => {
            isDisposed = true;
            unlisten?.();
        };
    }, [eventName, eventSchema, scope]);
}
