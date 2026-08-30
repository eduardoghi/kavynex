import type { MediaSourceMode, MediaType } from "../types/media";
import type { ImportMode } from "../types/settings";
import type { CreateMediaInput } from "../services/media-input-service";
import {
    composeCookiesBrowserSelector,
    normalizeCookiesBrowser,
    redactCookiesBrowserSelector,
} from "../constants/cookies-browsers";

// The subset of the add-media form the pure helpers below read. Declared explicitly (rather than
// importing the hook's return type) so these functions stay free of React and are unit-testable
// on their own. The whole point of extracting them out of use-add-media-workflow.
export type AddMediaFormFields = {
    sourceMode: MediaSourceMode;
    mediaUrl: string;
    mediaPath: string;
    title: string;
    thumbPath: string;
    mediaType: MediaType;
    selectedYtDlpFormatId: string;
    selectedYtDlpMediaType: MediaType;
    resolvedYoutubeVideoId: string | null;
    publishedAt: string;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    cookiesBrowser: string;
    // The optional profile typed next to the browser combo, appended to the browser by
    // composeCookiesBrowserSelector. Empty for the common single-profile case.
    cookiesBrowserProfile: string;
    cookiesPath: string;
    isGeneratingThumb: boolean;
    isLoadingYtDlpFormats: boolean;
};

// What the user is told when the profile they typed does not form a selector yt-dlp (and the
// backend's own validator) would accept. Shared by the submit validation and the format loader so
// both refusals read the same.
export const INVALID_COOKIES_BROWSER_PROFILE_MESSAGE =
    "The browser profile cannot be used as typed. Enter the profile name or its full path, without a leading dash or control characters.";

// True when the browser combo names a browser whose profile field, as typed, does not compose
// into a selector the validator accepts. "manual" and an empty selection carry no profile and are
// never invalid here. Exported so the form can refuse the same input before loading formats.
export function hasInvalidCookiesBrowserSelector(
    cookiesBrowser: string,
    cookiesBrowserProfile: string
): boolean {
    const selector = composeCookiesBrowserSelector(cookiesBrowser, cookiesBrowserProfile);

    return selector !== "" && normalizeCookiesBrowser(selector) === null;
}

// The outcome of validating the form before a submit. A hard error to surface, a silent skip
// (busy. A preparation/download/cancel is already in flight), or a green light with the resolved
// source.
export type AddMediaValidation =
    | { status: "error"; message: string }
    | { status: "skip" }
    | { status: "ok"; sourceMode: MediaSourceMode; sourceValue: string };

export function validateAddMediaForm(
    form: AddMediaFormFields,
    selectedChannelId: number | null,
    busy: { isCancellingYtDlp: boolean; isYtDlpRunning: boolean }
): AddMediaValidation {
    if (selectedChannelId === null) {
        return { status: "error", message: "Select a channel before adding media." };
    }

    const isPreparingMedia = form.isGeneratingThumb || form.isLoadingYtDlpFormats;

    if (busy.isCancellingYtDlp || isPreparingMedia || busy.isYtDlpRunning) {
        return { status: "skip" };
    }

    const sourceMode = form.sourceMode;
    const sourceValue =
        sourceMode === "yt-dlp" ? form.mediaUrl.trim() : form.mediaPath.trim();

    if (!sourceValue) {
        return {
            status: "error",
            message:
                sourceMode === "yt-dlp"
                    ? "Enter a media URL before continuing."
                    : "Select a media file before continuing.",
        };
    }

    if (sourceMode === "yt-dlp" && !form.selectedYtDlpFormatId.trim()) {
        return {
            status: "error",
            message: "Load the available formats and choose one before continuing.",
        };
    }

    // Refused here rather than dropped downstream. The backend treats an invalid selector as "no
    // cookies" and runs anyway, so without this the user who typed a bad profile would get an
    // unauthenticated download and a failure that names the wrong cause.
    if (
        sourceMode === "yt-dlp" &&
        hasInvalidCookiesBrowserSelector(form.cookiesBrowser, form.cookiesBrowserProfile)
    ) {
        return { status: "error", message: INVALID_COOKIES_BROWSER_PROFILE_MESSAGE };
    }

    return { status: "ok", sourceMode, sourceValue };
}

// Resolves the cookies source the format loader also uses. "manual" selects the user-picked .txt
// file and is never a real --cookies-from-browser value, so it must not be sent as one. A browser
// is sent with the optional profile appended (`browser:profile`), which is the selector yt-dlp
// reads; see composeCookiesBrowserSelector.
export function resolveCookiesSource(
    cookiesBrowser: string,
    cookiesPath: string,
    cookiesBrowserProfile = ""
): { cookiesBrowser: string | null; cookiesPath: string | null } {
    const isManual = cookiesBrowser === "manual";

    return {
        cookiesBrowser: isManual
            ? null
            : composeCookiesBrowserSelector(cookiesBrowser, cookiesBrowserProfile) || null,
        cookiesPath: isManual ? cookiesPath.trim() || null : null,
    };
}

// Builds the yt-dlp command line shown in the terminal preview. The cookies file path is never
// rendered (it can reveal the local profile layout and may be pasted into a public bug report);
// only a "<file>" placeholder is shown. A browser profile is redacted for the same reason (it is
// often a path under the user's home directory), keeping the browser name.
export function buildYtDlpCommandPreview(
    mediaUrl: string,
    cookiesBrowser: string | null,
    cookiesPath: string | null,
    formatId: string
): string {
    const authPreview = cookiesPath
        ? " --cookies <file>"
        : cookiesBrowser
          ? ` --cookies-from-browser ${redactCookiesBrowserSelector(cookiesBrowser)}`
          : "";

    return `yt-dlp ${mediaUrl.trim()}${authPreview} --format ${formatId}`;
}

// A unique run id for a yt-dlp download, preferring crypto.randomUUID and falling back to a
// timestamp+random string where it is unavailable.
export function generateYtDlpRunId(): string {
    return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Assembles the CreateMediaInput sent to the backend from the form and the resolved run context.
export function buildCreateMediaInput(
    form: AddMediaFormFields,
    context: {
        channelId: number;
        sourceMode: MediaSourceMode;
        sourceValue: string;
        importMode: ImportMode;
        libraryPath: string;
        ytDlpRunId: string;
        ytDlpFormatId: string;
        cookiesBrowser: string | null;
        cookiesPath: string | null;
    }
): CreateMediaInput {
    const isYtDlp = context.sourceMode === "yt-dlp";

    return {
        channelId: context.channelId,
        title: form.title.trim(),
        sourceMode: context.sourceMode,
        sourceValue: context.sourceValue,
        thumbnailSourcePath: form.thumbPath || null,
        mediaType: isYtDlp ? form.selectedYtDlpMediaType : form.mediaType,
        importMode: context.importMode,
        libraryPath: context.libraryPath,
        publishedAt: isYtDlp ? null : form.publishedAt.trim() || null,
        ytDlpRunId: context.ytDlpRunId,
        ytDlpFormatId: context.ytDlpFormatId,
        ytDlpYoutubeVideoId: isYtDlp ? form.resolvedYoutubeVideoId : null,
        downloadComments: form.downloadComments,
        downloadLiveChat: form.downloadLiveChat,
        cookiesBrowser: context.cookiesBrowser,
        cookiesPath: context.cookiesPath,
    };
}
