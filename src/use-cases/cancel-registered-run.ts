import { INVALID_RUN_ID_ERROR_CODE } from "../constants/error-codes";
import { cancelMediaDownload } from "../services/media-download-service";
import { parseAppError } from "../utils/app-error";

// How long a cancel waits before asking once more for a run the backend did not know yet. A run
// registers its id a moment after the call that starts it, and a cancel sent in that moment finds
// nothing and does nothing.
export const CANCEL_RETRY_DELAY_MS = 400;

// Cancels a run by id, asking a second time when the backend does not know the id yet. A run still
// unknown after that has ended, or is past the part a cancel can stop, and the refusal is thrown
// for the caller to tell which.
export async function cancelRegisteredRun(runId: string): Promise<void> {
    try {
        await cancelMediaDownload(runId);
    } catch (error) {
        if (parseAppError(error).code !== INVALID_RUN_ID_ERROR_CODE) {
            throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, CANCEL_RETRY_DELAY_MS));
        await cancelMediaDownload(runId);
    }
}
