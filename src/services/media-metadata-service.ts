import type { MediaType } from "../types/media";
import { fileSrcFromStoredPath } from "../utils/media-utils";

function createMediaElement(mediaType: MediaType): HTMLMediaElement {
    if (mediaType === "audio") {
        return document.createElement("audio");
    }

    return document.createElement("video");
}

export async function readMediaDurationInSeconds(
    filePath: string,
    libraryPath: string,
    mediaType: MediaType
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
            cleanup();
            resolve(value);
        };

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