import type { MediaType } from "../types/media";
import { fileSrcFromStoredPath } from "../utils/media-utils";

function createMediaElement(mediaType: MediaType): HTMLMediaElement {
    if (mediaType === "audio") {
        return document.createElement("audio");
    }

    return document.createElement("video");
}

// How long the probe waits for the element to report before giving up with null. An element
// whose src the asset protocol refuses fires `error` promptly, but one it never answers (or a
// decoder that wedges on an unusual container) fires nothing at all, and without this bound the
// Promise stayed pending and createMedia, which awaits it after the row already exists, never
// returned: the modal stayed locked on a media that had in fact been added. The same bound and the
// same reasoning as ASSET_PROBE_TIMEOUT_MS in lib/webview-check.ts. A null duration costs nothing
// (the column is nullable and the player measures it again on playback), so giving up is safe.
export const MEDIA_DURATION_PROBE_TIMEOUT_MS = 15_000;

export async function readMediaDurationInSeconds(
    filePath: string,
    libraryPath: string,
    mediaType: MediaType,
    timeoutMs: number = MEDIA_DURATION_PROBE_TIMEOUT_MS
): Promise<number | null> {
    const normalizedFilePath = filePath.trim();
    const normalizedLibraryPath = libraryPath.trim();

    if (!normalizedFilePath || !normalizedLibraryPath) {
        return null;
    }

    const fileSrc = fileSrcFromStoredPath(normalizedFilePath, normalizedLibraryPath);

    return new Promise<number | null>((resolve) => {
        const media = createMediaElement(mediaType);
        let settled = false;

        const cleanup = (): void => {
            media.onloadedmetadata = null;
            media.onerror = null;
            media.removeAttribute("src");
            media.load();
        };

        const finish = (value: number | null): void => {
            if (settled) {
                return;
            }

            settled = true;
            window.clearTimeout(timeoutId);
            cleanup();
            resolve(value);
        };

        const timeoutId = window.setTimeout(() => finish(null), timeoutMs);

        media.preload = "metadata";

        media.onloadedmetadata = () => {
            if (!Number.isFinite(media.duration) || media.duration <= 0) {
                finish(null);
                return;
            }

            finish(Math.floor(media.duration));
        };

        media.onerror = () => {
            finish(null);
        };

        media.src = fileSrc;
    });
}