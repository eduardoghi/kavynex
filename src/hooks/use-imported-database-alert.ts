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

// Names the ways forward that exist. Diagnostics lists which files are missing, and an import can be
// undone from Settings > Database. The backend sends this after a restore as well, since a backup
// can be older than the library folder in the same way.
function missingFilesMessage(missing: number): string {
    return (
        `The database Kavynex just switched to, by an import or a restore, lists ` +
        `${formatCount(missing, "file")} that ${missing === 1 ? "is" : "are"} not in your ` +
        "library folder. Nothing was deleted. Open Diagnostics to see which ones. An import can be " +
        "undone in Settings > Database."
    );
}

const IMPORT_FAILED_MESSAGE =
    "The database you imported could not be applied, so Kavynex is still using the previous one. " +
    "Nothing was lost. Try the import again from Settings > Database, and if it fails again the " +
    "log folder (Diagnostics) has the reason.";

const DISPLACED_MESSAGE =
    "Kavynex found a database import that had not finished and put the previous database back. " +
    "The database it found in its place was kept beside it as kavynex.db.displaced-*, in case it " +
    "holds work you expected to see. docs/DIRECTORIES.md says how to bring it back.";

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

            if (consumeStartupNotice("databaseDisplaced")) {
                onMissingFiles(DISPLACED_MESSAGE);
            }

            const missing = consumeStartupNotice("importedMissingFiles");

            // The count comes over IPC, so a zero must not produce a notice about "0 files".
            if (missing !== null && missing >= 1) {
                onMissingFiles(missingFilesMessage(missing));
            }
        },
    });
}
