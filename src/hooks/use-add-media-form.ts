import { useCallback, useEffect, useRef, useState } from "react";
import { pickFile, type FileDialogFilter } from "../services/file-dialog-service";
import type { MediaSourceMode, MediaType, YtDlpFormatOption } from "../types/media";
import {
    AUDIO_FILE_EXTENSIONS,
    fileNameFromPath,
    IMAGE_FILE_EXTENSIONS,
    isThumbnailFile,
    mediaTypeFromFile,
    VIDEO_FILE_EXTENSIONS,
} from "../utils/media-utils";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
import { ClientError, parseAppError } from "../utils/app-error";
import { YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE } from "../constants/error-codes";
import { stageManualThumbnail } from "../services/thumbnail-service";
import { useAddMediaFormState } from "./use-add-media-form-state";
import { useTempThumbnail } from "./use-temp-thumbnail";
import { useYtDlpFormatLoader } from "./use-yt-dlp-format-loader";
import {
    COOKIES_BROWSER_VALUES,
    composeCookiesBrowserSelector,
} from "../constants/cookies-browsers";
import {
    hasInvalidCookiesBrowserSelector,
    INVALID_COOKIES_BROWSER_PROFILE_MESSAGE,
} from "../use-cases/add-media";
import { useMemoObject } from "./use-memo-object";

// What each picker offers. The backend refuses anything else, and filtering here keeps a wrong
// file from being chosen in the first place (a .txt picked as media was classed as a video and only
// failed once the import ran).
const MEDIA_FILE_FILTERS: FileDialogFilter[] = [
    { name: "Video and audio", extensions: [...VIDEO_FILE_EXTENSIONS, ...AUDIO_FILE_EXTENSIONS] },
];
const IMAGE_FILE_FILTERS: FileDialogFilter[] = [
    { name: "Images", extensions: [...IMAGE_FILE_EXTENSIONS] },
];
const COOKIES_FILE_FILTERS: FileDialogFilter[] = [{ name: "Cookies file", extensions: ["txt"] }];

type UseAddMediaFormOptions = {
    onError?: (message: string) => void;
    ytDlpTerminal?: {
        startManualSession: (runId: string, header: string) => void;
        appendManualLog: (line: string) => void;
        markStopped: () => void;
        resetYtDlpState: (clearLogs?: boolean) => void;
    };
};

export type AddMediaFormController = {
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
    cookiesBrowserProfile: string;
    cookiesPath: string;
    isGeneratingThumb: boolean;

    ytDlpFormats: YtDlpFormatOption[];
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
    setCookiesBrowserProfile: (value: string) => void;
    setCookiesPath: (value: string) => void;
    pickCookiesFileViaDialog: () => Promise<void>;
    clearCookiesPath: () => void;
    setSelectedYtDlpFormatId: (value: string) => void;
    loadYtDlpFormats: () => Promise<void>;

    pickMediaViaDialog: () => Promise<void>;
    pickThumbViaDialog: () => Promise<void>;
    resetForm: () => Promise<void>;
};

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
}: UseAddMediaFormOptions = {}): AddMediaFormController {
    const formState = useAddMediaFormState();
    const [downloadComments, setDownloadComments] = useState(true);
    const [downloadLiveChat, setDownloadLiveChat] = useState(true);
    const [cookiesBrowser, setCookiesBrowserState] = useState("");
    // The optional profile (or `+keyring:profile`) appended to the browser when the selector is
    // composed. Kept apart from cookiesBrowser because the combo renders that value and a
    // composed `firefox:Work` would no longer match an option.
    const [cookiesBrowserProfile, setCookiesBrowserProfileState] = useState("");
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

    // The loader calls these getters when formats are requested, never during render, so they read
    // the latest values off a ref and keep one identity. Inline closures were new on every render,
    // and loadYtDlpFormats depends on them, so it was recreated on every keystroke.
    const loaderInputsRef = useRef({
        mediaUrl,
        title,
        cookiesBrowser,
        cookiesBrowserProfile,
        cookiesPath,
    });
    useEffect(() => {
        loaderInputsRef.current = {
            mediaUrl,
            title,
            cookiesBrowser,
            cookiesBrowserProfile,
            cookiesPath,
        };
    }, [mediaUrl, title, cookiesBrowser, cookiesBrowserProfile, cookiesPath]);

    // True while the title is one the form filled in (from the file name or from yt-dlp's metadata)
    // and the user has not typed over it. Only such a title is replaced when the file or URL changes,
    // so picking a second file or pasting a second URL no longer saves it under the first one's
    // name, and a typed title is never touched. A ref because it is read in callbacks and never
    // drives a render on its own.
    const titleAutoFilledRef = useRef(false);

    const getUrl = useCallback((): string => loaderInputsRef.current.mediaUrl, []);
    // An auto-filled title reads as empty, so the loader offers the new URL's title in its place.
    const getCurrentTitle = useCallback(
        (): string => (titleAutoFilledRef.current ? "" : loaderInputsRef.current.title),
        []
    );
    const setLoaderTitle = formState.setTitleState;
    const fillSuggestedTitle = useCallback(
        (value: string): void => {
            titleAutoFilledRef.current = true;
            setLoaderTitle(value);
        },
        [setLoaderTitle]
    );
    const getCookiesBrowser = useCallback((): string => {
        const inputs = loaderInputsRef.current;
        return composeCookiesBrowserSelector(inputs.cookiesBrowser, inputs.cookiesBrowserProfile);
    }, []);
    const getCookiesPath = useCallback((): string => {
        const inputs = loaderInputsRef.current;
        return inputs.cookiesBrowser === "manual" ? inputs.cookiesPath : "";
    }, []);

    const ytDlpState = useYtDlpFormatLoader({
        getUrl,
        getCurrentTitle,
        getCookiesBrowser,
        getCookiesPath,
        onSuggestedTitle: fillSuggestedTitle,
        onMediaTypeResolved: formState.setMediaTypeState,
        onTerminalStart: ytDlpTerminal?.startManualSession,
        onTerminalLog: ytDlpTerminal?.appendManualLog,
        onTerminalStop: ytDlpTerminal?.markStopped,
    });

    // Destructure the reference-stable actions off each sub-controller so the callbacks below can
    // depend on them individually, per CONTRIBUTING.md's hook conventions, instead of on the whole
    // sub-controller object, whose identity changes on any field change (see the note in
    // use-add-media-form-state) and would otherwise recreate these callbacks (and every per-card
    // handler derived from them) on every keystroke in an unrelated field.
    const {
        setSourceModeState,
        setMediaUrlState,
        setTitleState,
        setPublishedAtState,
        setMediaTypeState,
        applyLocalMediaSelectionState,
        resetFormState,
    } = formState;
    const { resetThumbState, generateThumbForMedia, setManualThumbPath } = thumbnailState;
    const { resetYtDlpFormats, loadYtDlpFormats: loadYtDlpFormatsFromLoader } = ytDlpState;

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

            resetYtDlpFormats();

            const detectedMediaType = mediaTypeFromFile(normalizedPath);
            const currentTitle = title.trim();

            let nextTitle: string | null = null;

            if (!currentTitle || titleAutoFilledRef.current) {
                const fileName = fileNameFromPath(normalizedPath);
                const titleWithoutExtension = fileName.replace(/\.[^.]+$/, "");
                nextTitle = titleWithoutExtension || fileName || "Untitled";
                titleAutoFilledRef.current = true;
            }

            applyLocalMediaSelectionState(normalizedPath, detectedMediaType, nextTitle);

            await resetThumbState();

            await generateThumbForMedia(normalizedPath);
        },
        [
            title,
            applyLocalMediaSelectionState,
            resetThumbState,
            generateThumbForMedia,
            resetYtDlpFormats,
        ]
    );

    const applyThumbSelection = useCallback(
        async (path: string): Promise<void> => {
            const normalizedPath = path.trim();

            if (!normalizedPath) {
                return;
            }

            // The picker only offers images, but a path can still arrive without one (a picker that
            // ignores filters). Saying so beats a selection that silently does nothing.
            if (!isThumbnailFile(normalizedPath)) {
                throw new ClientError(
                    `Please choose an image file (${IMAGE_FILE_EXTENSIONS.join(", ")}).`
                );
            }

            // The picked image lives outside the library, where the asset protocol cannot read it.
            // Stage a copy in the preview directory (which is authorized as a whole), and preview
            // that, rather than widening the scope to the file the user chose (see
            // stageManualThumbnail for why granting it was the worse option). The staged copy is
            // byte-identical, so persisting from it stores exactly the same file.
            //
            // A failure falls back to the picked path. The preview will not render, but the
            // selection still stands and the import still persists the right image. That is the
            // same non-fatal shape the grant had, for the same reason. A missing preview must not
            // block adding media.
            let previewPath = normalizedPath;
            let staged = false;

            try {
                previewPath = await stageManualThumbnail(normalizedPath);
                staged = true;
            } catch (error) {
                logError("add-media-form", "Failed to stage the thumbnail preview.", error);
            }

            // Only a staged copy is ours to delete later; the fallback is the user's own file.
            await setManualThumbPath(previewPath, staged);
        },
        [setManualThumbPath]
    );

    const pickSinglePathFromDialog = useCallback(
        async (filters: FileDialogFilter[]): Promise<string> => {
            return (await pickFile({ filters })) ?? "";
        },
        []
    );

    // Invalidating the resolved yt-dlp formats and clearing the terminal always go together. Any
    // change to an input that affects the fetched result (the URL, cookies, the source mode) makes
    // the previously loaded formats stale. Kept as one callback so the many call sites below cannot
    // drift. A site doing one reset but forgetting the other was the duplication this removes.
    // Depends on the callback rather than the ytDlpTerminal object, which a caller may build inline.
    const resetYtDlpTerminal = ytDlpTerminal?.resetYtDlpState;
    const resetYtDlpSelectionState = useCallback((): void => {
        resetYtDlpFormats();
        resetYtDlpTerminal?.(true);
    }, [resetYtDlpFormats, resetYtDlpTerminal]);

    const pickCookiesFileViaDialog = useCallback(async (): Promise<void> => {
        try {
            const selectedPath = await pickSinglePathFromDialog(COOKIES_FILE_FILTERS);

            if (!selectedPath) {
                return;
            }

            if (!isCookiesTextFile(selectedPath)) {
                throw new ClientError("Please choose a valid .txt cookies file.");
            }

            setCookiesBrowserState("manual");
            setCookiesPathState(selectedPath);
            resetYtDlpSelectionState();
        } catch (error) {
            reportError("add-media-form", "Failed to select cookies file.", error);
        }
    }, [pickSinglePathFromDialog, reportError, resetYtDlpSelectionState]);

    const clearCookiesPath = useCallback((): void => {
        setCookiesPathState("");
        resetYtDlpSelectionState();
    }, [resetYtDlpSelectionState]);

    const setSourceMode = useCallback(
        async (value: MediaSourceMode): Promise<void> => {
            if (value === sourceMode) {
                return;
            }

            setSourceModeState(value);
            titleAutoFilledRef.current = false;
            resetYtDlpSelectionState();
            setDownloadComments(true);
            setDownloadLiveChat(true);
            setCookiesBrowserState("");
            setCookiesBrowserProfileState("");
            setCookiesPathState("");
            await resetThumbState();
        },
        [sourceMode, setSourceModeState, resetThumbState, resetYtDlpSelectionState]
    );

    const setMediaUrl = useCallback(
        (value: string): void => {
            setMediaUrlState(value);

            if (sourceMode === "yt-dlp") {
                // The title came from the previous URL, so it no longer names anything.
                if (titleAutoFilledRef.current) {
                    titleAutoFilledRef.current = false;
                    setTitleState("");
                }

                resetYtDlpSelectionState();
                setPublishedAtState("");
                setMediaTypeState("video");
            }
        },
        [
            sourceMode,
            setMediaUrlState,
            setTitleState,
            setPublishedAtState,
            setMediaTypeState,
            resetYtDlpSelectionState,
        ]
    );

    const setTitle = useCallback(
        (value: string): void => {
            titleAutoFilledRef.current = false;
            setTitleState(value);
        },
        [setTitleState]
    );

    const setPublishedAt = useCallback(
        (value: string): void => {
            setPublishedAtState(value);
        },
        [setPublishedAtState]
    );

    const setCookiesBrowser = useCallback(
        (value: string): void => {
            const normalized = normalizeCookiesBrowser(value);

            setCookiesBrowserState(normalized);

            if (normalized !== "manual") {
                setCookiesPathState("");
            }

            // A profile belongs to the browser it was typed for. Clearing the combo or switching
            // to the cookies file drops it, so a stale value cannot silently ride along with the
            // next browser the user picks.
            if (normalized === "" || normalized === "manual") {
                setCookiesBrowserProfileState("");
            }

            resetYtDlpSelectionState();
        },
        [resetYtDlpSelectionState]
    );

    const setCookiesBrowserProfile = useCallback(
        (value: string): void => {
            // Stored as typed (trimmed only when composed) so the field does not fight the cursor
            // over a trailing space while the user is still writing. The loaded formats go stale
            // for the same reason a browser change invalidates them. The cookies decide what
            // YouTube answers.
            setCookiesBrowserProfileState(value);
            resetYtDlpSelectionState();
        },
        [resetYtDlpSelectionState]
    );

    const setCookiesPath = useCallback(
        (value: string): void => {
            setCookiesPathState(value.trim());
            resetYtDlpSelectionState();
        },
        [resetYtDlpSelectionState]
    );

    const loadYtDlpFormats = useCallback(async (): Promise<void> => {
        try {
            // The same refusal the submit applies. The service layer would drop an invalid
            // selector and probe without cookies, and the formats that came back would not be the
            // ones the chosen profile can see.
            if (hasInvalidCookiesBrowserSelector(cookiesBrowser, cookiesBrowserProfile)) {
                throw new ClientError(INVALID_COOKIES_BROWSER_PROFILE_MESSAGE);
            }

            await loadYtDlpFormatsFromLoader();
        } catch (error) {
            // The user pressed Cancel. That is the outcome they asked for, not a failure to report,
            // which is how `addMedia` treats the same code for a download.
            if (parseAppError(error).code === YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE) {
                return;
            }

            // Neither the profile nor the cookies file path is in the details. Both are usually
            // paths under the user's home directory, and this context reaches the file log. Whether a
            // cookies file was set is what a bug report needs.
            reportError("add-media-form", "Failed to load yt-dlp formats.", error, {
                mediaUrl: mediaUrl.trim(),
                cookiesBrowser,
                cookiesFileSet: cookiesPath.trim() !== "",
            });
        }
    }, [
        cookiesBrowser,
        cookiesBrowserProfile,
        cookiesPath,
        mediaUrl,
        reportError,
        loadYtDlpFormatsFromLoader,
    ]);

    const pickMediaViaDialog = useCallback(async (): Promise<void> => {
        try {
            const selectedPath = await pickSinglePathFromDialog(MEDIA_FILE_FILTERS);

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
            const selectedPath = await pickSinglePathFromDialog(IMAGE_FILE_FILTERS);

            if (!selectedPath) {
                return;
            }

            await applyThumbSelection(selectedPath);
        } catch (error) {
            reportError("add-media-form", "Failed to select thumbnail image.", error);
        }
    }, [applyThumbSelection, pickSinglePathFromDialog, reportError]);

    const resetForm = useCallback(async (): Promise<void> => {
        resetFormState();
        titleAutoFilledRef.current = false;
        resetYtDlpSelectionState();
        setDownloadComments(true);
        setDownloadLiveChat(true);
        setCookiesBrowserState("");
        setCookiesBrowserProfileState("");
        setCookiesPathState("");
        await resetThumbState();
    }, [resetFormState, resetThumbState, resetYtDlpSelectionState]);

    // Destructure the sub-state fields the returned object exposes so the memo below can depend
    // on them directly (honest dependency array, no eslint-disable).
    const { thumbPath, isGeneratingThumb } = thumbnailState;
    const {
        ytDlpFormats,
        selectedYtDlpFormatId,
        isLoadingYtDlpFormats,
        selectedYtDlpMediaType,
        resolvedYoutubeVideoId,
        setSelectedYtDlpFormatId,
    } = ytDlpState;

    // Memoized so the controller object keeps a stable identity across renders. Consumers that
    // depend on the whole object (e.g. use-add-media-workflow) stop being invalidated (and
    // recreating their own callbacks), on every keystroke in an unrelated field.
    return useMemoObject({
        sourceMode,
        mediaUrl,
        title,
        mediaPath,
        mediaType,
        thumbPath,
        publishedAt,
        downloadComments,
        downloadLiveChat,
        cookiesBrowser,
        cookiesBrowserProfile,
        cookiesPath,
        isGeneratingThumb,

        ytDlpFormats,
        selectedYtDlpFormatId,
        isLoadingYtDlpFormats,
        selectedYtDlpMediaType,
        resolvedYoutubeVideoId,

        setSourceMode,
        setMediaUrl,
        setTitle,
        setPublishedAt,
        setDownloadComments,
        setDownloadLiveChat,
        setCookiesBrowser,
        setCookiesBrowserProfile,
        setCookiesPath,
        pickCookiesFileViaDialog,
        clearCookiesPath,
        setSelectedYtDlpFormatId,
        loadYtDlpFormats,

        pickMediaViaDialog,
        pickThumbViaDialog,
        resetForm,
    });
}