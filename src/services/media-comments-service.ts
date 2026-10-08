import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import type { YtDlpComment } from "../types/media";

/**
 * Merges fetched comments into the ones already saved for this media and resolves to how many it
 * holds afterwards. Nothing saved is removed, so a fetch that misses comments YouTube has since
 * deleted leaves them in the backup.
 */
export async function mergeMediaCommentsInBackend(
    mediaId: number,
    comments: YtDlpComment[]
): Promise<number> {
    return invokeCommand(TAURI_COMMANDS.MERGE_MEDIA_COMMENTS, {
        mediaId,
        comments,
    });
}

/**
 * Records that a comment fetch for this media came back with nothing, leaving whatever is already
 * saved untouched.
 *
 * The backend refuses to downgrade a media that does have stored comments, so this is safe to call
 * blind.
 */
export async function markMediaCommentsAbsentInBackend(mediaId: number): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.MARK_MEDIA_COMMENTS_ABSENT, { mediaId });
}
