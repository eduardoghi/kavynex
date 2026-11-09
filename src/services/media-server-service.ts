import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import { setMediaServerOrigin } from "../utils/media-utils";

let loading: Promise<void> | null = null;

/**
 * Asks the backend once where the player reads media from, and hands the answer to
 * `mediaSrcFromAbsolutePath`. On Linux that is the loopback server (see
 * src-tauri/src/services/media_server.rs), and elsewhere null, which keeps the `kvxmedia` scheme.
 *
 * Every caller shares the one request. A failure leaves the scheme in place and is not retried,
 * since a backend that could not answer this at boot will not answer it later either.
 */
export function loadMediaServerOrigin(): Promise<void> {
    loading ??= invokeCommand(TAURI_COMMANDS.MEDIA_SERVER_ORIGIN)
        .then((origin) => setMediaServerOrigin(origin))
        .catch(() => setMediaServerOrigin(null));

    return loading;
}
