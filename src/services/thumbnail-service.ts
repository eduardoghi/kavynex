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

/**
 * Copies an image the user picked into the app's preview directory and returns its path there.
 *
 * The preview is drawn from that copy rather than from the file the user chose, because the preview
 * directory is already authorized in the asset-protocol scope as a whole. The alternative. Granting
 * the chosen file: is what this replaced: Tauri's scope cannot withdraw a grant, so those
 * accumulated for the session, and revoking one would have made the same image picked for a second
 * media silently render nothing (a forbid outranks every later allow).
 *
 * The copy is byte-identical, so persisting from it lands exactly the file that would have been
 * stored before, and it is cleaned up through `deleteTemporaryThumbnail` like any generated preview.
 */
export async function stageManualThumbnail(sourcePath: string): Promise<string> {
    const normalizedSourcePath = normalizeString(sourcePath);

    if (!normalizedSourcePath) {
        throw new ClientError("Thumbnail path is required.");
    }

    return normalizeString(
        await invokeCommand(TAURI_COMMANDS.STAGE_MANUAL_THUMBNAIL, {
            path: normalizedSourcePath,
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

// Fetching a thumbnail by URL is not called from here any more: its only caller resolved the
// thumbnail for a media being created, and that whole sequence runs in the backend now
// (`create_media`). The avatar download below stays, because it is its own operation. A user
// changing a channel's picture, with no artifacts-without-a-row window behind it.

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
 * What one call learned about the paths it asked about.
 *
 * Two collections rather than one map, because "no derivative" is two different facts and the caller
 * has to act on them differently: it stops asking about a `settled` path and keeps asking about
 * anything else. Folding them back into a single map here would discard on this side exactly the
 * distinction the backend was changed to report.
 */
export type DisplayThumbnailResolution = {
    /** Library-relative thumbnail path -> absolute path of its display-sized copy. */
    displayPaths: ReadonlyMap<string, string>;
    /**
     * Every path this call answered for good, both the ones that resolved and the ones that never
     * will. Asking about any of these again cannot change the answer.
     */
    settledPaths: ReadonlySet<string>;
};

const EMPTY_RESOLUTION: DisplayThumbnailResolution = {
    displayPaths: new Map(),
    settledPaths: new Set(),
};

/**
 * Asks the backend for display-sized copies of a page of stored thumbnails, keyed by the
 * library-relative path each one answers.
 *
 * The grid renders the stored thumbnail at whatever size it was saved (a yt-dlp `maxresdefault` is
 * 1280x720) into a card a few hundred pixels wide, and a webview decodes an image at its natural
 * size regardless of how well it is compressed. This is what lets a card draw a smaller decode
 * instead.
 *
 * A path with no derivative is simply absent from `displayPaths`, which is the normal answer rather
 * than a failure: the caller keeps rendering the stored file. Blanks and duplicates are dropped
 * before the call so the backend's per-call generation budget is spent on distinct real work.
 */
export async function resolveDisplayThumbnails(
    relativePaths: readonly (string | null | undefined)[],
    libraryPath: string
): Promise<DisplayThumbnailResolution> {
    const normalizedLibraryPath = normalizeString(libraryPath);

    if (!normalizedLibraryPath) {
        return EMPTY_RESOLUTION;
    }

    const requested = [
        ...new Set(
            relativePaths
                .map((relativePath) => normalizeString(relativePath ?? ""))
                .filter((relativePath) => relativePath.length > 0)
        ),
    ];

    if (requested.length === 0) {
        return EMPTY_RESOLUTION;
    }

    const resolved = await invokeCommand(TAURI_COMMANDS.RESOLVE_DISPLAY_THUMBNAILS, {
        relativePaths: requested,
        libraryPath: normalizedLibraryPath,
    });

    const displayPaths = new Map<string, string>();
    const settledPaths = new Set<string>();

    requested.forEach((relativePath, index) => {
        const answer = resolved[index];

        // An answer shorter than the request leaves the tail unsettled rather than shifting the
        // remaining answers onto it: an entry with no answer was not decided, so it is asked about
        // again rather than recorded as final.
        if (!answer) {
            return;
        }

        if (answer.kind === "resolved") {
            const displayPath = normalizeString(answer.path);

            if (displayPath) {
                displayPaths.set(relativePath, displayPath);
                settledPaths.add(relativePath);
            }

            return;
        }

        // `budgetSpent` is the one answer worth asking about again, so it is deliberately not
        // settled; `unavailable` is final.
        if (answer.kind === "unavailable") {
            settledPaths.add(relativePath);
        }
    });

    return { displayPaths, settledPaths };
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