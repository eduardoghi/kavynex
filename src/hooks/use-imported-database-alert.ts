import { EVENT_IMPORTED_DATABASE_MISSING_FILES } from "../constants/events";
import { IPC_EVENT_SCHEMAS } from "../lib/ipc-schemas";
import { consumeStartupNotice } from "../services/startup-notices";
import { formatCount } from "../utils/pluralize";
import { useStartupNotice } from "./use-startup-notice";

type UseImportedDatabaseAlertOptions = {
    // Surfaces the notice to the user. A notice and not an error, since nothing was deleted. The
    // rows point at files this library folder does not have.
    onMissingFiles: (message: string) => void;
    // Surfaces a staged import that could not be applied at startup. An error, since the import the
    // user asked for did not happen.
    onImportFailed: (message: string) => void;
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

const IMPORT_FAILED_MESSAGE =
    "The database you imported could not be applied, so Kavynex is still using the previous one. " +
    "Nothing was lost. Try the import again from Settings > Database, and if it fails again the " +
    "log folder (Diagnostics) has the reason.";

// Surfaces what happened to a database import once it was applied at startup. The backend runs the
// Diagnostics library check once after an import is applied, and this turns its result into
// something the user sees before opening a video that is not there. A failure to apply at all is
// recorded before the window exists, so only the take on mount reaches it.
export function useImportedDatabaseAlert({
    onMissingFiles,
    onImportFailed,
}: UseImportedDatabaseAlertOptions): void {
    useStartupNotice({
        event: {
            name: EVENT_IMPORTED_DATABASE_MISSING_FILES,
            schema: IPC_EVENT_SCHEMAS.importedDatabaseMissingFiles,
        },
        scope: "db-import",
        show: () => {
            if (consumeStartupNotice("importApplyFailed")) {
                onImportFailed(IMPORT_FAILED_MESSAGE);
            }

            const missing = consumeStartupNotice("importedMissingFiles");

            // The count comes over IPC, so a zero must not produce a notice about "0 files".
            if (missing !== null && missing >= 1) {
                onMissingFiles(missingFilesMessage(missing));
            }
        },
    });
}
