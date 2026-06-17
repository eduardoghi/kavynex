import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import type { YtDlpComment } from "../types/media";

export async function replaceMediaCommentsInBackend(
    mediaId: number,
    comments: YtDlpComment[]
): Promise<number> {
    return invokeCommand<number>(TAURI_COMMANDS.REPLACE_MEDIA_COMMENTS, {
        mediaId,
        comments,
    });
}
