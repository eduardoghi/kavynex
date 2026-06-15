import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, invokeVoid } from "../lib/tauri-client";
import type { DownloadedMediaResult, YtDlpFormatsResult } from "../types/media";
import { createAppError } from "../utils/app-error";
import { COOKIES_BROWSER_VALUES } from "../constants/cookies-browsers";

function normalizeCookiesBrowser(value: string | null | undefined): string | null {
    const normalized = value?.trim().toLowerCase() ?? "";
    return COOKIES_BROWSER_VALUES.has(normalized) ? normalized : null;
}

function normalizeCookiesPath(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? "";
    return normalized ? normalized : null;
}

export async function listYtDlpFormats(
    url: string,
    cookiesBrowser?: string | null,
    cookiesPath?: string | null
): Promise<YtDlpFormatsResult> {
    const normalizedUrl = url.trim();

    if (!normalizedUrl) {
        return {
            suggested_title: "",
            formats: [],
            terminal_logs: [],
        };
    }

    return invokeCommand<YtDlpFormatsResult>(TAURI_COMMANDS.LIST_YT_DLP_FORMATS, {
        url: normalizedUrl,
        cookiesBrowser: normalizeCookiesBrowser(cookiesBrowser),
        cookiesPath: normalizeCookiesPath(cookiesPath),
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

    return invokeCommand<DownloadedMediaResult>(TAURI_COMMANDS.DOWNLOAD_MEDIA_FROM_URL, {
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
    cookiesPath?: string | null
): Promise<
    {
        comment_id: string | null;
        parent_comment_id: string | null;
        author_name: string;
        author_channel_id: string | null;
        text: string;
        like_count: number;
        published_at: string | null;
    }[]
> {
    const normalizedVideoId = youtubeVideoId.trim();

    if (!normalizedVideoId) {
        throw createAppError("INVALID_YOUTUBE_VIDEO_ID", "youtube video id is empty");
    }

    return invokeCommand("fetch_youtube_comments", {
        videoId: normalizedVideoId,
        cookiesBrowser: normalizeCookiesBrowser(cookiesBrowser),
        cookiesPath: normalizeCookiesPath(cookiesPath),
    });
}