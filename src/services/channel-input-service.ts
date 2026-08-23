import { createAppError } from "../utils/app-error";
import {
    INVALID_CHANNEL_ID_ERROR_CODE,
    INVALID_CHANNEL_NAME_ERROR_CODE,
    INVALID_LIBRARY_PATH_ERROR_CODE,
    INVALID_YOUTUBE_HANDLE_ERROR_CODE,
} from "../constants/error-codes";
import { assertValidEntityId } from "../utils/id-validation";
import { isValidNormalizedYoutubeHandle, normalizeYoutubeHandle } from "../utils/youtube";

export type CreateChannelInput = {
    name: string;
    youtubeHandle: string;
    avatarPath?: string | null;
};

export type NormalizedCreateChannelInput = {
    name: string;
    youtubeHandle: string;
    avatarPath: string | null;
};

export function validateCreateChannelInput(
    input: CreateChannelInput
): NormalizedCreateChannelInput {
    const normalizedName = input.name.trim();
    const normalizedHandle = normalizeYoutubeHandle(input.youtubeHandle);
    const normalizedAvatarPath = input.avatarPath?.trim() || null;

    if (!normalizedName) {
        throw createAppError(
            INVALID_CHANNEL_NAME_ERROR_CODE,
            "Channel name is required."
        );
    }

    if (!normalizedHandle) {
        throw createAppError(
            INVALID_YOUTUBE_HANDLE_ERROR_CODE,
            "YouTube handle is required."
        );
    }

    if (!isValidNormalizedYoutubeHandle(normalizedHandle)) {
        throw createAppError(
            INVALID_YOUTUBE_HANDLE_ERROR_CODE,
            "Invalid YouTube handle. Use formats like @channelname, channel/..., c/... or user/..."
        );
    }

    return {
        name: normalizedName,
        youtubeHandle: normalizedHandle,
        avatarPath: normalizedAvatarPath,
    };
}

// The only channel id check on the frontend. The media input service used to carry a second
// copy (same rule, same code as a string literal), which is the shape where one copy drifts.
export function validateChannelId(channelId: number): void {
    assertValidEntityId(channelId, INVALID_CHANNEL_ID_ERROR_CODE, "Channel id is invalid.");
}

export function requireLibraryPath(
    libraryPath: string,
    message = "Library folder must be configured for this operation."
): string {
    const normalizedLibraryPath = libraryPath.trim();

    if (!normalizedLibraryPath) {
        throw createAppError(
            INVALID_LIBRARY_PATH_ERROR_CODE,
            message
        );
    }

    return normalizedLibraryPath;
}