import { useCallback, useState } from "react";
import { pickFile } from "../services/file-dialog-service";
import {
    hasInvalidCookiesBrowserSelector,
    INVALID_COOKIES_BROWSER_PROFILE_MESSAGE,
    isMissingCookiesFile,
    MISSING_COOKIES_FILE_MESSAGE,
    resolveCookiesSource,
} from "../use-cases/add-media";
import { COOKIES_FILE_FILTERS, isCookiesTextFile } from "../utils/cookies-file";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";
import { useMemoObject } from "./use-memo-object";
import type { BatchImportOptions } from "./use-batch-import";
import type { BatchQuality } from "./use-batch-formats";

export type BatchImportOptionsController = {
    // The rule "Pre-select all" applies, and the first pre-selection a listing makes.
    quality: BatchQuality;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    // The add-media form's cookie fields, held the same way (see CookiesFields).
    cookiesBrowser: string;
    cookiesBrowserProfile: string;
    cookiesPath: string;
    // Why the options cannot start a batch, or null.
    error: string | null;
    setQuality: (value: BatchQuality) => void;
    setDownloadComments: (value: boolean) => void;
    setDownloadLiveChat: (value: boolean) => void;
    setCookiesBrowser: (value: string) => void;
    setCookiesBrowserProfile: (value: string) => void;
    pickCookiesFile: () => Promise<void>;
    clearCookiesPath: () => void;
    // The options a batch (and its format listings) runs with, or null (and `error` set) when the
    // cookies are not usable.
    resolve: () => BatchImportOptions | null;
};

// The options of a batch import, chosen once for every media in it. Kept for as long as the channel
// page is, so "Retry failed" and the next batch start from the last choice.
export function useBatchImportOptions(): BatchImportOptionsController {
    const [quality, setQuality] = useState<BatchQuality>("best");
    const [downloadComments, setDownloadComments] = useState(true);
    const [downloadLiveChat, setDownloadLiveChat] = useState(true);
    const [cookiesBrowser, setCookiesBrowserState] = useState("");
    const [cookiesBrowserProfile, setCookiesBrowserProfile] = useState("");
    const [cookiesPath, setCookiesPath] = useState("");
    const [error, setError] = useState<string | null>(null);

    const setCookiesBrowser = useCallback((value: string): void => {
        setCookiesBrowserState(value);
        setError(null);
    }, []);

    const pickCookiesFile = useCallback(async (): Promise<void> => {
        try {
            // Picked for the cookies purpose, which is what the backend then accepts it for.
            const picked = (await pickFile("cookies", { filters: COOKIES_FILE_FILTERS })) ?? "";

            if (!picked) {
                return;
            }

            if (!isCookiesTextFile(picked)) {
                setError("Please choose a valid .txt cookies file.");
                return;
            }

            setCookiesBrowserState("manual");
            setCookiesPath(picked);
            setError(null);
        } catch (failure) {
            logError("batch-import", "Failed to select a cookies file.", failure);
            setError(resolveErrorMessage(failure, "Failed to select the cookies file."));
        }
    }, []);

    const clearCookiesPath = useCallback((): void => {
        setCookiesPath("");
    }, []);

    const resolve = useCallback((): BatchImportOptions | null => {
        // The refusals the add-media form applies before it loads formats or downloads.
        if (hasInvalidCookiesBrowserSelector(cookiesBrowser, cookiesBrowserProfile)) {
            setError(INVALID_COOKIES_BROWSER_PROFILE_MESSAGE);
            return null;
        }

        if (isMissingCookiesFile(cookiesBrowser, cookiesPath)) {
            setError(MISSING_COOKIES_FILE_MESSAGE);
            return null;
        }

        setError(null);

        return {
            downloadComments,
            downloadLiveChat,
            ...resolveCookiesSource(cookiesBrowser, cookiesPath, cookiesBrowserProfile),
        };
    }, [
        cookiesBrowser,
        cookiesBrowserProfile,
        cookiesPath,
        downloadComments,
        downloadLiveChat,
    ]);

    return useMemoObject({
        quality,
        downloadComments,
        downloadLiveChat,
        cookiesBrowser,
        cookiesBrowserProfile,
        cookiesPath,
        error,
        setQuality,
        setDownloadComments,
        setDownloadLiveChat,
        setCookiesBrowser,
        setCookiesBrowserProfile,
        pickCookiesFile,
        clearCookiesPath,
        resolve,
    });
}
