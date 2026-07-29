import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import { normalizeString } from "../utils/guards";
import { ClientError } from "../utils/app-error";

export async function generateTemporaryThumbnail(mediaPath: string): Promise<string> {
    const normalizedMediaPath = normalizeString(mediaPath);

    if (!normalizedMediaPath) {
        throw new ClientError("Media path is required.");
    }

    return normalizeString(
        await invokeCommand(TAURI_COMMANDS.GENERATE_TEMP_THUMBNAIL, {
            path: normalizedMediaPath,
        })
    );
}

export async function persistThumbnailFile(
    sourcePath: string,
    libraryPath: string
): Promise<string> {
    const normalizedSourcePath = normalizeString(sourcePath);
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedSourcePath) {
        throw new ClientError("Thumbnail source path is required.");
    }

    if (!normalizedLibraryPath) {
        throw new ClientError("Library path is required.");
    }

    return normalizeString(
        await invokeCommand(TAURI_COMMANDS.PERSIST_THUMBNAIL_FILE, {
            path: normalizedSourcePath,
            libraryPath: normalizedLibraryPath,
        })
    );
}

export async function downloadThumbnailFromUrl(
    url: string,
    libraryPath: string
): Promise<string> {
    const normalizedUrl = normalizeString(url);
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedUrl) {
        throw new ClientError("Thumbnail URL is required.");
    }

    if (!normalizedLibraryPath) {
        throw new ClientError("Library path is required.");
    }

    return normalizeString(
        await invokeCommand(TAURI_COMMANDS.DOWNLOAD_THUMBNAIL_FROM_URL, {
            url: normalizedUrl,
            libraryPath: normalizedLibraryPath,
        })
    );
}

export async function downloadChannelAvatarFromHandle(
    youtubeHandle: string,
    libraryPath: string
): Promise<string> {
    const normalizedYoutubeHandle = normalizeString(youtubeHandle);
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedYoutubeHandle) {
        throw new ClientError("YouTube handle is required.");
    }

    if (!normalizedLibraryPath) {
        throw new ClientError("Library path is required.");
    }

    return normalizeString(
        await invokeCommand(TAURI_COMMANDS.DOWNLOAD_CHANNEL_AVATAR_FROM_HANDLE, {
            youtubeHandle: normalizedYoutubeHandle,
            libraryPath: normalizedLibraryPath,
        })
    );
}

/**
 * Asks the backend for display-sized copies of a page of stored thumbnails, keyed by the
 * library-relative path each one answers.
 *
 * The grid renders the stored thumbnail at whatever size it was saved (a yt-dlp `maxresdefault` is
 * 1280x720) into a card a few hundred pixels wide, and a webview decodes an image at its natural
 * size regardless of how well it is compressed. This is what lets a card draw a smaller decode
 * instead.
 *
 * A path with no derivative is simply absent from the map, which is the normal answer rather than a
 * failure: the caller keeps rendering the stored file. Blanks and duplicates are dropped before the
 * call so the backend's per-call generation budget is spent on distinct real work.
 */
export async function resolveDisplayThumbnails(
    relativePaths: readonly (string | null | undefined)[],
    libraryPath: string
): Promise<ReadonlyMap<string, string>> {
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedLibraryPath) {
        return new Map();
    }

    const requested = [
        ...new Set(
            relativePaths
                .map((relativePath) => normalizeString(relativePath ?? ""))
                .filter((relativePath) => relativePath.length > 0)
        ),
    ];

    if (requested.length === 0) {
        return new Map();
    }

    const resolved = await invokeCommand(TAURI_COMMANDS.RESOLVE_DISPLAY_THUMBNAILS, {
        relativePaths: requested,
        libraryPath: normalizedLibraryPath,
    });

    const displayPaths = new Map<string, string>();

    requested.forEach((relativePath, index) => {
        const displayPath = normalizeString(resolved[index] ?? "");

        if (displayPath) {
            displayPaths.set(relativePath, displayPath);
        }
    });

    return displayPaths;
}

export async function deleteTemporaryThumbnail(tempThumbnailPath: string): Promise<void> {
    const normalizedTempThumbnailPath = normalizeString(tempThumbnailPath);

    if (!normalizedTempThumbnailPath) {
        return;
    }

    await invokeCommand(TAURI_COMMANDS.DELETE_TEMP_THUMBNAIL, {
        path: normalizedTempThumbnailPath,
    });
}

export async function deleteThumbnailFile(
    thumbnailPath: string,
    libraryPath: string
): Promise<void> {
    const normalizedThumbnailPath = normalizeString(thumbnailPath);
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedThumbnailPath || !normalizedLibraryPath) {
        return;
    }

    await invokeCommand(TAURI_COMMANDS.DELETE_THUMBNAIL_FILE, {
        thumbnailPath: normalizedThumbnailPath,
        libraryPath: normalizedLibraryPath,
    });
}