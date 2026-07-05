import type { ImportMode } from "../types/settings";
import type { MediaSourceMode, MediaType } from "../types/media";
import { createAppError } from "../utils/app-error";
import { assertValidEntityId } from "../utils/id-validation";
import { COOKIES_BROWSER_VALUES } from "../constants/cookies-browsers";

export type CreateMediaInput = {
    channelId: number;
    title: string;
    sourceMode: MediaSourceMode;
    sourceValue: string;
    thumbnailSourcePath: string | null;
    mediaType: MediaType;
    importMode: ImportMode;
    libraryPath: string;
    publishedAt: string | null;
    ytDlpRunId: string;
    ytDlpFormatId: string;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    cookiesBrowser: string | null;
};

function normalizeOptionalValue(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? "";
    return normalized || null;
}

function normalizeRequiredValue(value: string): string {
    return value.trim();
}

function normalizeCookiesBrowser(value: string | null | undefined): string | null {
    const normalized = value?.trim().toLowerCase() ?? "";
    return COOKIES_BROWSER_VALUES.has(normalized) ? normalized : null;
}

export function validateCreateMediaInput(input: CreateMediaInput): CreateMediaInput {
    const normalizedTitle = normalizeRequiredValue(input.title);
    const normalizedSourceValue = normalizeRequiredValue(input.sourceValue);
    const normalizedLibraryPath = normalizeRequiredValue(input.libraryPath);
    const normalizedThumbnailSourcePath = normalizeOptionalValue(input.thumbnailSourcePath);
    const normalizedPublishedAt = normalizeOptionalValue(input.publishedAt);
    const normalizedYtDlpRunId = normalizeRequiredValue(input.ytDlpRunId);
    const normalizedYtDlpFormatId = normalizeRequiredValue(input.ytDlpFormatId);
    const normalizedCookiesBrowser = normalizeCookiesBrowser(input.cookiesBrowser);

    validateChannelId(input.channelId);

    if (!normalizedTitle) {
        throw createAppError("INVALID_MEDIA_CREATION_ARGUMENTS", "Media title is required.");
    }

    if (!normalizedSourceValue) {
        throw createAppError("INVALID_MEDIA_CREATION_ARGUMENTS", "Media source is required.");
    }

    if (!normalizedLibraryPath) {
        throw createAppError("INVALID_LIBRARY_PATH", "Library path is empty.");
    }

    if (input.sourceMode === "yt-dlp") {
        if (!normalizedYtDlpRunId) {
            throw createAppError("INVALID_RUN_ID", "yt-dlp run id is required.");
        }

        if (!normalizedYtDlpFormatId) {
            throw createAppError("INVALID_FORMAT_ID", "yt-dlp format id is required.");
        }
    }

    return {
        ...input,
        title: normalizedTitle,
        sourceValue: normalizedSourceValue,
        libraryPath: normalizedLibraryPath,
        thumbnailSourcePath: normalizedThumbnailSourcePath,
        publishedAt: normalizedPublishedAt,
        ytDlpRunId: normalizedYtDlpRunId,
        ytDlpFormatId: normalizedYtDlpFormatId,
        downloadComments: Boolean(input.downloadComments),
        downloadLiveChat: Boolean(input.downloadLiveChat),
        cookiesBrowser: normalizedCookiesBrowser,
    };
}

export function validateMediaId(mediaId: number): void {
    assertValidEntityId(mediaId, "INVALID_MEDIA_PATH", "Media id is invalid.");
}

export function validateChannelId(channelId: number): void {
    assertValidEntityId(channelId, "INVALID_CHANNEL_ID", "Channel id is invalid.");
}