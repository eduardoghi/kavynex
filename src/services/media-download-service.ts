import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import type { DownloadedMediaResult, YtDlpComment, YtDlpFormatsResult } from "../types/media";
import { createAppError } from "../utils/app-error";
import { normalizeCookiesBrowser } from "../constants/cookies-browsers";

function normalizeCookiesPath(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? "";
    return normalized ? normalized : null;
}

function normalizeRunId(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? "";
    return normalized ? normalized : null;
}

// The run id under which a comment refresh for `mediaId` is registered on the backend, so a
// separate "cancel" click can target that exact run. Derived deterministically from the media id
// (rather than a random id threaded through React state) so the caller and the canceller agree on
// it without extra plumbing.
export function commentsRefreshRunId(mediaId: number): string {
    return `comments-refresh-${mediaId}`;
}

export async function listYtDlpFormats(
    url: string,
    cookiesBrowser?: string | null,
    cookiesPath?: string | null,
    runId?: string | null
): Promise<YtDlpFormatsResult> {
    const normalizedUrl = url.trim();

    if (!normalizedUrl) {
        return {
            suggested_title: "",
            youtube_video_id: null,
            formats: [],
            terminal_logs: [],
        };
    }

    return invokeCommand(TAURI_COMMANDS.LIST_YT_DLP_FORMATS, {
        url: normalizedUrl,
        cookiesBrowser: normalizeCookiesBrowser(cookiesBrowser),
        cookiesPath: normalizeCookiesPath(cookiesPath),
        // Optional: when set, the backend registers the run so cancelMediaDownload(runId) can abort
        // a slow format probe instead of it running to the yt-dlp timeout.
        runId: normalizeRunId(runId),
    });
}

export async function downloadMediaFromUrl(
    url: string,
    libraryPath: string,
    runId: string,
    formatId: string,
    cookiesBrowser?: string | null,
    cookiesPath?: string | null,
    downloadLiveChat = false,
    skipAutoThumbnailDownload = false
): Promise<DownloadedMediaResult> {
    const normalizedUrl = url.trim();
    const normalizedLibraryPath = libraryPath.trim();
    const normalizedRunId = runId.trim();
    const normalizedFormatId = formatId.trim();

    if (!normalizedUrl) {
        throw createAppError("INVALID_URL", "url is empty");
    }

    if (!normalizedLibraryPath) {
        throw createAppError("INVALID_LIBRARY_PATH", "library path is empty");
    }

    if (!normalizedRunId) {
        throw createAppError("INVALID_RUN_ID", "run id is empty");
    }

    if (!normalizedFormatId) {
        throw createAppError("INVALID_FORMAT_ID", "format id is empty");
    }

    return invokeCommand(TAURI_COMMANDS.DOWNLOAD_MEDIA_FROM_URL, {
        url: normalizedUrl,
        libraryPath: normalizedLibraryPath,
        runId: normalizedRunId,
        formatId: normalizedFormatId,
        downloadLiveChat: Boolean(downloadLiveChat),
        skipAutoThumbnailDownload: Boolean(skipAutoThumbnailDownload),
        cookiesBrowser: normalizeCookiesBrowser(cookiesBrowser),
        cookiesPath: normalizeCookiesPath(cookiesPath),
    });
}

export async function cancelMediaDownload(runId: string): Promise<void> {
    const normalizedRunId = runId.trim();

    if (!normalizedRunId) {
        throw createAppError("INVALID_RUN_ID", "run id is empty");
    }

    await invokeVoid(TAURI_COMMANDS.CANCEL_MEDIA_DOWNLOAD, {
        runId: normalizedRunId,
    });
}

export async function fetchYouTubeComments(
    youtubeVideoId: string,
    cookiesBrowser?: string | null,
    cookiesPath?: string | null,
    runId?: string | null
): Promise<YtDlpComment[]> {
    const normalizedVideoId = youtubeVideoId.trim();

    if (!normalizedVideoId) {
        throw createAppError("INVALID_YOUTUBE_VIDEO_ID", "youtube video id is empty");
    }

    return invokeCommand(TAURI_COMMANDS.FETCH_YOUTUBE_COMMENTS, {
        videoId: normalizedVideoId,
        cookiesBrowser: normalizeCookiesBrowser(cookiesBrowser),
        cookiesPath: normalizeCookiesPath(cookiesPath),
        // Optional: when set, the backend registers the run so cancelMediaDownload(runId) can abort
        // a comment backup (which can run for minutes) instead of it running to the yt-dlp timeout.
        runId: normalizeRunId(runId),
    });
}