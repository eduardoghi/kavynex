import { parseAppError, type AppErrorShape } from "./app-error";
import {
    APP_ERROR_CODE,
    INVALID_INPUT_ERROR_CODE,
    INVALID_URL_ERROR_CODE,
    INVALID_RUN_ID_ERROR_CODE,
    INVALID_FORMAT_ID_ERROR_CODE,
    INVALID_DIRECTORY_PATH_ERROR_CODE,
    READ_DIR_FAILED_ERROR_CODE,
    INVALID_LIBRARY_PATH_ERROR_CODE,
    INVALID_LIBRARY_MIGRATION_ERROR_CODE,
    INVALID_MEDIA_PATH_ERROR_CODE,
    INVALID_THUMBNAIL_PATH_ERROR_CODE,
    INVALID_TEMP_THUMBNAIL_PATH_ERROR_CODE,
    INVALID_SOURCE_MEDIA_ERROR_CODE,
    SOURCE_MEDIA_NOT_FOUND_ERROR_CODE,
    INVALID_SOURCE_THUMBNAIL_ERROR_CODE,
    SOURCE_THUMBNAIL_NOT_FOUND_ERROR_CODE,
    INVALID_THUMBNAIL_FILE_ERROR_CODE,
    THUMBNAIL_NOT_SUPPORTED_FOR_AUDIO_ERROR_CODE,
    CHANNEL_ALREADY_EXISTS_ERROR_CODE,
    INVALID_YOUTUBE_HANDLE_ERROR_CODE,
    INVALID_CHANNEL_NAME_ERROR_CODE,
    INVALID_MEDIA_CREATION_ARGUMENTS_ERROR_CODE,
    MEDIA_IMPORT_FAILED_ERROR_CODE,
    VIDEO_ALREADY_EXISTS_FOR_CHANNEL_ERROR_CODE,
    YT_DLP_NOT_FOUND_ERROR_CODE,
    YT_DLP_METADATA_TIMEOUT_ERROR_CODE,
    YT_DLP_DOWNLOAD_TIMEOUT_ERROR_CODE,
    YT_DLP_THUMBNAIL_TIMEOUT_ERROR_CODE,
    YT_DLP_DOWNLOAD_FAILED_ERROR_CODE,
    YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE,
    YT_DLP_THUMBNAIL_FAILED_ERROR_CODE,
    YT_DLP_METADATA_FAILED_ERROR_CODE,
    FFMPEG_NOT_FOUND_ERROR_CODE,
    FFMPEG_FAILED_ERROR_CODE,
    FFMPEG_EXEC_FAILED_ERROR_CODE,
    DESTINATION_ALREADY_EXISTS_ERROR_CODE,
    PATH_OUTSIDE_BASE_DIR_ERROR_CODE,
} from "../constants/error-codes";

const DEFAULT_ERROR_MESSAGE = "Unknown error.";

const FRIENDLY_ERROR_MESSAGES: Record<string, string> = {
    [APP_ERROR_CODE]: DEFAULT_ERROR_MESSAGE,
    [INVALID_INPUT_ERROR_CODE]: "Invalid input.",

    [INVALID_URL_ERROR_CODE]: "Enter a valid media URL.",
    [INVALID_RUN_ID_ERROR_CODE]: "The download session is invalid.",
    [INVALID_FORMAT_ID_ERROR_CODE]: "Choose a valid format before continuing.",

    [INVALID_DIRECTORY_PATH_ERROR_CODE]: "Choose a valid folder.",
    [INVALID_LIBRARY_PATH_ERROR_CODE]: "Configure a valid library folder before continuing.",
    [INVALID_LIBRARY_MIGRATION_ERROR_CODE]: "The selected library migration path is not valid.",
    [INVALID_MEDIA_PATH_ERROR_CODE]: "The selected media item is invalid.",
    [INVALID_THUMBNAIL_PATH_ERROR_CODE]: "The selected thumbnail is invalid.",
    [INVALID_TEMP_THUMBNAIL_PATH_ERROR_CODE]: "The temporary thumbnail is invalid.",

    [INVALID_SOURCE_MEDIA_ERROR_CODE]: "Select a valid media file.",
    [SOURCE_MEDIA_NOT_FOUND_ERROR_CODE]: "The selected media file was not found.",
    [INVALID_SOURCE_THUMBNAIL_ERROR_CODE]: "Select a valid thumbnail image.",
    [SOURCE_THUMBNAIL_NOT_FOUND_ERROR_CODE]: "The selected thumbnail image was not found.",
    [INVALID_THUMBNAIL_FILE_ERROR_CODE]: "Choose a valid thumbnail image file.",
    [THUMBNAIL_NOT_SUPPORTED_FOR_AUDIO_ERROR_CODE]:
        "Automatic thumbnail generation is not available for audio files.",

    [INVALID_CHANNEL_NAME_ERROR_CODE]: "Enter a valid channel name.",
    [INVALID_YOUTUBE_HANDLE_ERROR_CODE]: "Enter a valid YouTube handle.",
    [CHANNEL_ALREADY_EXISTS_ERROR_CODE]: "A channel with this YouTube handle already exists.",

    [INVALID_MEDIA_CREATION_ARGUMENTS_ERROR_CODE]: "Invalid media creation arguments.",
    [MEDIA_IMPORT_FAILED_ERROR_CODE]: "The media import failed.",
    [VIDEO_ALREADY_EXISTS_FOR_CHANNEL_ERROR_CODE]:
        "This media is already registered for the selected channel.",

    [YT_DLP_NOT_FOUND_ERROR_CODE]:
        "yt-dlp was not found. Install yt-dlp or place the binary in the app tools folder.",
    [YT_DLP_METADATA_TIMEOUT_ERROR_CODE]: "Timed out while loading media information from yt-dlp.",
    [YT_DLP_METADATA_FAILED_ERROR_CODE]: "yt-dlp could not load media information for this URL.",
    [YT_DLP_DOWNLOAD_TIMEOUT_ERROR_CODE]: "The media download took too long and was interrupted.",
    [YT_DLP_DOWNLOAD_FAILED_ERROR_CODE]: "The media download failed.",
    [YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE]: "The media download was cancelled.",
    [YT_DLP_THUMBNAIL_TIMEOUT_ERROR_CODE]: "Timed out while downloading the thumbnail.",
    [YT_DLP_THUMBNAIL_FAILED_ERROR_CODE]: "The thumbnail download failed.",

    [FFMPEG_NOT_FOUND_ERROR_CODE]:
        "ffmpeg was not found. Install ffmpeg or place the binary in the app tools folder.",
    [FFMPEG_EXEC_FAILED_ERROR_CODE]: "ffmpeg could not be started.",
    [FFMPEG_FAILED_ERROR_CODE]: "ffmpeg could not process the media file.",

    [DESTINATION_ALREADY_EXISTS_ERROR_CODE]:
        "A file with the same destination already exists.",
    [PATH_OUTSIDE_BASE_DIR_ERROR_CODE]:
        "The selected file path is outside the allowed library folder.",

    [READ_DIR_FAILED_ERROR_CODE]: "Could not read the selected folder.",
    // The codes below are not (yet) emitted by the Rust backend (see src-tauri/src/error.rs)
    // and are kept as bare literals rather than added to KnownErrorCode.
    CREATE_DIR_FAILED: "Could not create the selected folder.",
    OPEN_DIR_FAILED: "Could not open the selected folder.",
    OPEN_PATH_FAILED: "Could not open the selected path.",
    WRITE_FILE_FAILED: "Could not write the file.",
    DELETE_FILE_FAILED: "Could not delete the file.",
};

function resolveFriendlyMessage(parsed: AppErrorShape): string {
    const mappedMessage = FRIENDLY_ERROR_MESSAGES[parsed.code];

    if (mappedMessage) {
        return mappedMessage;
    }

    if (parsed.message?.trim()) {
        return parsed.message.trim();
    }

    return DEFAULT_ERROR_MESSAGE;
}

function shouldAppendDetails(parsed: AppErrorShape, resolvedMessage: string): boolean {
    const details = parsed.details?.trim();

    if (!details) {
        return false;
    }

    if (resolvedMessage === DEFAULT_ERROR_MESSAGE) {
        return false;
    }

    const normalizedResolved = resolvedMessage.trim().toLowerCase();
    const normalizedDetails = details.toLowerCase();

    if (normalizedResolved === normalizedDetails) {
        return false;
    }

    if (normalizedDetails.startsWith(normalizedResolved)) {
        return false;
    }

    return true;
}

function buildResolvedMessage(parsed: AppErrorShape): string {
    const resolvedMessage = resolveFriendlyMessage(parsed);

    if (!shouldAppendDetails(parsed, resolvedMessage)) {
        return resolvedMessage;
    }

    return `${resolvedMessage}\n\nDetails: ${parsed.details?.trim()}`;
}

export function toUserFriendlyError(error: unknown): string {
    const parsed = parseAppError(error);
    return buildResolvedMessage(parsed);
}

export function resolveErrorMessage(error: unknown, fallbackMessage: string): string {
    const parsed = parseAppError(error);
    const resolved = buildResolvedMessage(parsed);

    if (resolved !== DEFAULT_ERROR_MESSAGE) {
        return resolved;
    }

    if (fallbackMessage.trim()) {
        return fallbackMessage.trim();
    }

    return DEFAULT_ERROR_MESSAGE;
}