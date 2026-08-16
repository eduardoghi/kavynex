import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import type { YtDlpComment } from "../types/media";

export async function replaceMediaCommentsInBackend(
    mediaId: number,
    comments: YtDlpComment[]
): Promise<number> {
    return invokeCommand(TAURI_COMMANDS.REPLACE_MEDIA_COMMENTS, {
        mediaId,
        comments,
    });
}

/**
 * Records that a comment fetch for this media came back with nothing, leaving whatever is already
 * saved untouched.
 *
 * Separate from `replaceMediaCommentsInBackend` because that one deletes before it inserts: calling
 * it with an empty list to record the same fact would wipe a saved backup on the strength of a later
 * fetch returning nothing, which is the opposite of what this app is for. The backend additionally
 * refuses to downgrade a media that does have stored comments, so this is safe to call blind.
 */
export async function markMediaCommentsAbsentInBackend(mediaId: number): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.MARK_MEDIA_COMMENTS_ABSENT, { mediaId });
}
