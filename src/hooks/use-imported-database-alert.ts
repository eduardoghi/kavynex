import { useEffect } from "react";
import { EVENT_IMPORTED_DATABASE_MISSING_FILES } from "../constants/events";
import { IPC_EVENT_SCHEMAS } from "../lib/ipc-schemas";
import { listenValidated } from "../lib/tauri-client";
import { formatCount } from "../utils/pluralize";
import { logError } from "../utils/app-logger";

type UseImportedDatabaseAlertOptions = {
    // Surfaces the notice to the user. A notice and not an error, since nothing was deleted. The
    // rows point at files this library folder does not have.
    onMissingFiles: (message: string) => void;
};

// Names the two ways forward that exist. Diagnostics lists which files are missing, and the import
// can be undone from Settings > Database, which brings the previous database back.
function missingFilesMessage(missing: number): string {
    return (
        `The imported database lists ${formatCount(missing, "file")} that ` +
        `${missing === 1 ? "is" : "are"} not in your library folder. Nothing was deleted. ` +
        "Open Diagnostics to see which ones, or undo the import in Settings > Database."
    );
}

// Subscribes to the backend's imported-database-missing-files event and surfaces it. The backend
// runs the Diagnostics library check once after an import is applied, and this is what turns its
// result into something the user sees before opening a video that is not there.
export function useImportedDatabaseAlert({ onMissingFiles }: UseImportedDatabaseAlertOptions): void {
    useEffect(() => {
        // StrictMode double-invokes effects. Guard so a late-resolving listener registered by the
        // torn-down first pass is cleaned up rather than leaking.
        let isDisposed = false;
        let unlisten: (() => void) | null = null;

        void (async () => {
            try {
                const stop = await listenValidated(
                    EVENT_IMPORTED_DATABASE_MISSING_FILES,
                    IPC_EVENT_SCHEMAS.importedDatabaseMissingFiles,
                    (payload) => {
                        // The backend only emits with at least one, but the schema only proves the
                        // count is a number, so a zero must not produce a notice about "0 files".
                        if (payload.missing < 1) {
                            return;
                        }

                        onMissingFiles(missingFilesMessage(payload.missing));
                    }
                );

                if (isDisposed) {
                    stop();
                    return;
                }

                unlisten = stop;
            } catch (error) {
                // Failing to subscribe must never affect the app. The backend logs the count
                // regardless.
                logError(
                    "db-import",
                    "Failed to subscribe to the imported-database-missing-files event.",
                    error
                );
            }
        })();

        return () => {
            isDisposed = true;
            unlisten?.();
        };
    }, [onMissingFiles]);
}
