import { useEffect } from "react";
import { getDb } from "../lib/db";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";

type UseAppBootstrapOptions = {
    onError: (message: string) => void;
};

export function useAppBootstrap({
    onError,
}: UseAppBootstrapOptions): void {
    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                await getDb();
            } catch (error) {
                logError("bootstrap", "Failed to initialize app.", error);

                if (!cancelled) {
                    onError(resolveErrorMessage(error, "Failed to initialize app."));
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [onError]);
}