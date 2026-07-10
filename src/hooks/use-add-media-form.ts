import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { MediaSourceMode, MediaType, YtDlpFormat } from "../types/media";
import { fileNameFromPath, isThumbnailFile, mediaTypeFromFile } from "../utils/media-utils";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
import { allowAssetFile } from "../services/asset-scope-service";
import { useAddMediaFormState } from "./use-add-media-form-state";
import { useTempThumbnail } from "./use-temp-thumbnail";
import { useYtDlpFormatLoader } from "./use-yt-dlp-format-loader";
import { COOKIES_BROWSER_VALUES } from "../constants/cookies-browsers";

type UseAddMediaFormOptions = {
    onError?: (message: string) => void;
    ytDlpTerminal?: {
        startManualSession: (runId: string, header: string) => void;
        appendManualLog: (line: string) => void;
        markStopped: () => void;
        resetYtDlpState: (clearLogs?: boolean) => void;
    };
};

type UseAddMediaFormReturn = {
    sourceMode: MediaSourceMode;
    mediaUrl: string;
    title: string;
    mediaPath: string;
    mediaType: MediaType;
    thumbPath: string;
    publishedAt: string;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    cookiesBrowser: string;
    cookiesPath: string;
    isGeneratingThumb: boolean;

    ytDlpFormats: YtDlpFormat[];
    selectedYtDlpFormatId: string;
    isLoadingYtDlpFormats: boolean;
    selectedYtDlpMediaType: MediaType;
    resolvedYoutubeVideoId: string | null;

    setSourceMode: (value: MediaSourceMode) => Promise<void>;
    setMediaUrl: (value: string) => void;
    setTitle: (value: string) => void;
    setPublishedAt: (value: string) => void;
    setDownloadComments: (value: boolean) => void;
    setDownloadLiveChat: (value: boolean) => void;
    setCookiesBrowser: (value: string) => void;
    setCookiesPath: (value: string) => void;
    pickCookiesFileViaDialog: () => Promise<void>;
    clearCookiesPath: () => void;
    setSelectedYtDlpFormatId: (value: string) => void;
    loadYtDlpFormats: () => Promise<void>;

    pickMediaViaDialog: () => Promise<void>;
    pickThumbViaDialog: () => Promise<void>;
    resetForm: () => Promise<void>;
};

function normalizeSelectedPath(selection: string | string[] | null): string {
    if (typeof selection !== "string") {
        return "";
    }

    return selection.trim();
}

function normalizeCookiesBrowser(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "manual") return normalized;
    return COOKIES_BROWSER_VALUES.has(normalized) ? normalized : "";
}

function isCookiesTextFile(path: string): boolean {
    const normalized = path.trim().toLowerCase();

    if (!normalized) {
        return false;
    }

    return normalized.endsWith(".txt");
}

export function useAddMediaForm({
    onError,
    ytDlpTerminal,
}: UseAddMediaFormOptions = {}): UseAddMediaFormReturn {
    const formState = useAddMediaFormState();
    const [downloadComments, setDownloadComments] = useState(true);
    const [downloadLiveChat, setDownloadLiveChat] = useState(true);
    const [cookiesBrowser, setCookiesBrowserState] = useState("");
    const [cookiesPath, setCookiesPathState] = useState("");

    const {
        sourceMode,
        mediaUrl,
        title,
        mediaPath,
        mediaType,
        publishedAt,
    } = formState.state;

    const thumbnailState = useTempThumbnail();

    const ytDlpState = useYtDlpFormatLoader({
        getUrl: () => formState.state.mediaUrl,
        getCurrentTitle: () => formState.state.title,
        getCookiesBrowser: () => (cookiesBrowser === "manual" ? "" : cookiesBrowser),
        getCookiesPath: () => (cookiesBrowser === "manual" ? cookiesPath : ""),
        onSuggestedTitle: (value) => formState.setTitleState(value),
        onMediaTypeResolved: (value) => formState.setMediaTypeState(value),
        onTerminalStart: ytDlpTerminal?.startManualSession,
        onTerminalLog: ytDlpTerminal?.appendManualLog,
        onTerminalStop: ytDlpTerminal?.markStopped,
    });

    const reportError = useCallback(
        (
            scope: string,
            fallbackMessage: string,
            error: unknown,
            details?: Record<string, unknown>
        ): void => {
            logError(scope, fallbackMessage, error, details);
            onError?.(resolveErrorMessage(error, fallbackMessage));
        },
        [onError]
    );

    const applyMediaSelection = useCallback(
        async (path: string): Promise<void> => {
            const normalizedPath = path.trim();

            if (!normalizedPath) {
                return;
            }

            ytDlpState.resetYtDlpFormats();

            const detectedMediaType = mediaTypeFromFile(normalizedPath);
            const currentTitle = formState.state.title.trim();

            let nextTitle: string | null = null;

            if (!currentTitle) {
                const fileName = fileNameFromPath(normalizedPath);
                const titleWithoutExtension = fileName.replace(/\.[^.]+$/, "");
                nextTitle = titleWithoutExtension || fileName || "Untitled";
            }

            formState.applyLocalMediaSelectionState(
                normalizedPath,
                detectedMediaType,
                nextTitle
            );

            await thumbnailState.resetThumbState();

            await thumbnailState.generateThumbForMedia(normalizedPath);
        },
        [formState, thumbnailState, ytDlpState]
    );

    const applyThumbSelection = useCallback(
        async (path: string): Promise<void> => {
            const normalizedPath = path.trim();

            if (!normalizedPath || !isThumbnailFile(normalizedPath)) {
                return;
            }

            // The picked thumbnail lives outside the library. Authorize the asset
            // protocol to read this specific file so the preview can load. Failure is
            // non-fatal: only the preview thumbnail would be missing.
            try {
                await allowAssetFile(normalizedPath);
            } catch (error) {
                logError("add-media-form", "Failed to authorize thumbnail preview.", error);
            }

            await thumbnailState.setManualThumbPath(normalizedPath);
        },
        [thumbnailState]
    );

    const pickSinglePathFromDialog = useCallback(async (): Promise<string> => {
        const selection = await open({
            multiple: false,
            directory: false,
        });

        return normalizeSelectedPath(selection);
    }, []);

    const pickCookiesFileViaDialog = useCallback(async (): Promise<void> => {
        try {
            const selectedPath = await pickSinglePathFromDialog();

            if (!selectedPath) {
                return;
            }

            if (!isCookiesTextFile(selectedPath)) {
                throw new Error("Please choose a valid .txt cookies file.");
            }

            setCookiesBrowserState("manual");
            setCookiesPathState(selectedPath);
            ytDlpState.resetYtDlpFormats();
            ytDlpTerminal?.resetYtDlpState(true);
        } catch (error) {
            reportError("add-media-form", "Failed to select cookies file.", error);
        }
    }, [pickSinglePathFromDialog, reportError, ytDlpState, ytDlpTerminal]);

    const clearCookiesPath = useCallback((): void => {
        setCookiesPathState("");
        ytDlpState.resetYtDlpFormats();
        ytDlpTerminal?.resetYtDlpState(true);
    }, [ytDlpState, ytDlpTerminal]);

    const setSourceMode = useCallback(
        async (value: MediaSourceMode): Promise<void> => {
            if (value === formState.state.sourceMode) {
                return;
            }

            formState.setSourceModeState(value);
            ytDlpState.resetYtDlpFormats();
            ytDlpTerminal?.resetYtDlpState(true);
            setDownloadComments(true);
            setDownloadLiveChat(true);
            setCookiesBrowserState("");
            setCookiesPathState("");
            await thumbnailState.resetThumbState();
        },
        [formState, thumbnailState, ytDlpState, ytDlpTerminal]
    );

    const setMediaUrl = useCallback(
        (value: string): void => {
            formState.setMediaUrlState(value);

            if (formState.state.sourceMode === "yt-dlp") {
                ytDlpState.resetYtDlpFormats();
                ytDlpTerminal?.resetYtDlpState(true);
                formState.setPublishedAtState("");
                formState.setMediaTypeState("video");
            }
        },
        [formState, ytDlpState, ytDlpTerminal]
    );

    const setTitle = useCallback(
        (value: string): void => {
            formState.setTitleState(value);
        },
        [formState]
    );

    const setPublishedAt = useCallback(
        (value: string): void => {
            formState.setPublishedAtState(value);
        },
        [formState]
    );

    const setCookiesBrowser = useCallback(
        (value: string): void => {
            const normalized = normalizeCookiesBrowser(value);

            setCookiesBrowserState(normalized);

            if (normalized !== "manual") {
                setCookiesPathState("");
            }

            ytDlpState.resetYtDlpFormats();
            ytDlpTerminal?.resetYtDlpState(true);
        },
        [ytDlpState, ytDlpTerminal]
    );

    const setCookiesPath = useCallback(
        (value: string): void => {
            setCookiesPathState(value.trim());
            ytDlpState.resetYtDlpFormats();
            ytDlpTerminal?.resetYtDlpState(true);
        },
        [ytDlpState, ytDlpTerminal]
    );

    const loadYtDlpFormats = useCallback(async (): Promise<void> => {
        try {
            await ytDlpState.loadYtDlpFormats();
        } catch (error) {
            reportError("add-media-form", "Failed to load yt-dlp formats.", error, {
                mediaUrl: formState.state.mediaUrl.trim(),
                cookiesBrowser,
                cookiesPath,
            });
        }
    }, [cookiesBrowser, cookiesPath, formState.state.mediaUrl, reportError, ytDlpState]);

    const pickMediaViaDialog = useCallback(async (): Promise<void> => {
        try {
            const selectedPath = await pickSinglePathFromDialog();

            if (!selectedPath) {
                return;
            }

            await applyMediaSelection(selectedPath);
        } catch (error) {
            reportError("add-media-form", "Failed to select media file.", error);
        }
    }, [applyMediaSelection, pickSinglePathFromDialog, reportError]);

    const pickThumbViaDialog = useCallback(async (): Promise<void> => {
        try {
            const selectedPath = await pickSinglePathFromDialog();

            if (!selectedPath) {
                return;
            }

            await applyThumbSelection(selectedPath);
        } catch (error) {
            reportError("add-media-form", "Failed to select thumbnail image.", error);
        }
    }, [applyThumbSelection, pickSinglePathFromDialog, reportError]);

    const resetForm = useCallback(async (): Promise<void> => {
        formState.resetFormState();
        ytDlpState.resetYtDlpFormats();
        ytDlpTerminal?.resetYtDlpState(true);
        setDownloadComments(true);
        setDownloadLiveChat(true);
        setCookiesBrowserState("");
        setCookiesPathState("");
        await thumbnailState.resetThumbState();
    }, [formState, thumbnailState, ytDlpState, ytDlpTerminal]);

    return {
        sourceMode,
        mediaUrl,
        title,
        mediaPath,
        mediaType,
        thumbPath: thumbnailState.thumbPath,
        publishedAt,
        downloadComments,
        downloadLiveChat,
        cookiesBrowser,
        cookiesPath,
        isGeneratingThumb: thumbnailState.isGeneratingThumb,

        ytDlpFormats: ytDlpState.ytDlpFormats,
        selectedYtDlpFormatId: ytDlpState.selectedYtDlpFormatId,
        isLoadingYtDlpFormats: ytDlpState.isLoadingYtDlpFormats,
        selectedYtDlpMediaType: ytDlpState.selectedYtDlpMediaType,
        resolvedYoutubeVideoId: ytDlpState.resolvedYoutubeVideoId,

        setSourceMode,
        setMediaUrl,
        setTitle,
        setPublishedAt,
        setDownloadComments,
        setDownloadLiveChat,
        setCookiesBrowser,
        setCookiesPath,
        pickCookiesFileViaDialog,
        clearCookiesPath,
        setSelectedYtDlpFormatId: ytDlpState.setSelectedYtDlpFormatId,
        loadYtDlpFormats,

        pickMediaViaDialog,
        pickThumbViaDialog,
        resetForm,
    };
}