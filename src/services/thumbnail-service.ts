import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeTauri } from "../lib/tauri-client";
import { normalizeString } from "../utils/guards";
import { ClientError } from "../utils/app-error";

export async function generateTemporaryThumbnail(mediaPath: string): Promise<string> {
    const normalizedMediaPath = normalizeString(mediaPath);

    if (!normalizedMediaPath) {
        throw new ClientError("Media path is required.");
    }

    return normalizeString(
        await invokeTauri<string>(TAURI_COMMANDS.GENERATE_TEMP_THUMBNAIL, {
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
        await invokeTauri<string>(TAURI_COMMANDS.PERSIST_THUMBNAIL_FILE, {
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
        await invokeTauri<string>(TAURI_COMMANDS.DOWNLOAD_THUMBNAIL_FROM_URL, {
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
        await invokeTauri<string>(TAURI_COMMANDS.DOWNLOAD_CHANNEL_AVATAR_FROM_HANDLE, {
            youtubeHandle: normalizedYoutubeHandle,
            libraryPath: normalizedLibraryPath,
        })
    );
}

export async function deleteTemporaryThumbnail(tempThumbnailPath: string): Promise<void> {
    const normalizedTempThumbnailPath = normalizeString(tempThumbnailPath);

    if (!normalizedTempThumbnailPath) {
        return;
    }

    await invokeTauri<void>(TAURI_COMMANDS.DELETE_TEMP_THUMBNAIL, {
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

    await invokeTauri<void>(TAURI_COMMANDS.DELETE_THUMBNAIL_FILE, {
        thumbnailPath: normalizedThumbnailPath,
        libraryPath: normalizedLibraryPath,
    });
}