import { useCallback, useMemo, useRef, useState } from "react";
import { listYtDlpFormats } from "../services/media-download-service";
import type { MediaType, YtDlpFormat } from "../types/media";
import { resolveErrorMessage } from "../utils/error-message";
import {
    buildMergedFormats,
    inferPreferredFormatId,
    inferSelectedMediaType,
} from "../services/yt-dlp-format-rules";

type UseYtDlpFormatLoaderOptions = {
    getUrl: () => string;
    getCurrentTitle: () => string;
    getCookiesBrowser?: () => string;
    getCookiesPath?: () => string;
    onSuggestedTitle: (value: string) => void;
    onMediaTypeResolved: (value: MediaType) => void;
    onTerminalStart?: (runId: string, header: string) => void;
    onTerminalLog?: (line: string) => void;
    onTerminalStop?: () => void;
};

type UseYtDlpFormatLoaderReturn = {
    ytDlpFormats: YtDlpFormat[];
    selectedYtDlpFormatId: string;
    isLoadingYtDlpFormats: boolean;
    selectedYtDlpMediaType: MediaType;
    setSelectedYtDlpFormatId: (value: string) => void;
    resetYtDlpFormats: () => void;
    loadYtDlpFormats: () => Promise<void>;
};

const FORMAT_LOADER_RUN_ID = "format-loader";

export function useYtDlpFormatLoader({
    getUrl,
    getCurrentTitle,
    getCookiesBrowser,
    getCookiesPath,
    onSuggestedTitle,
    onMediaTypeResolved,
    onTerminalStart,
    onTerminalLog,
    onTerminalStop,
}: UseYtDlpFormatLoaderOptions): UseYtDlpFormatLoaderReturn {
    const [ytDlpFormats, setYtDlpFormats] = useState<YtDlpFormat[]>([]);
    const [selectedYtDlpFormatId, setSelectedYtDlpFormatIdState] = useState("");
    const [isLoadingYtDlpFormats, setIsLoadingYtDlpFormats] = useState(false);

    // Guards against a stale format response overwriting state after the URL changed (or was
    // reset) while yt-dlp was running - otherwise the formats/selection for an old URL could
    // repopulate over the current one, and that selection feeds the real download command.
    const latestRequestIdRef = useRef(0);

    const selectedYtDlpMediaType = useMemo<MediaType>(() => {
        return inferSelectedMediaType(ytDlpFormats, selectedYtDlpFormatId);
    }, [selectedYtDlpFormatId, ytDlpFormats]);

    const resetYtDlpFormats = useCallback((): void => {
        // Invalidate any in-flight load so its response cannot repopulate the cleared state.
        latestRequestIdRef.current += 1;
        setYtDlpFormats([]);
        setSelectedYtDlpFormatIdState("");
        onMediaTypeResolved("video");
    }, [onMediaTypeResolved]);

    const setSelectedYtDlpFormatId = useCallback(
        (value: string): void => {
            const nextSelectedFormatId = value.trim();

            setSelectedYtDlpFormatIdState(nextSelectedFormatId);

            if (!nextSelectedFormatId) {
                onMediaTypeResolved("video");
                return;
            }

            onMediaTypeResolved(inferSelectedMediaType(ytDlpFormats, nextSelectedFormatId));
        },
        [onMediaTypeResolved, ytDlpFormats]
    );

    const loadYtDlpFormats = useCallback(async (): Promise<void> => {
        const url = getUrl().trim();
        const cookiesBrowser = getCookiesBrowser?.().trim() || "";
        const cookiesPath = getCookiesPath?.().trim() || "";

        if (!url) {
            resetYtDlpFormats();
            return;
        }

        if (isLoadingYtDlpFormats) {
            return;
        }

        const requestId = ++latestRequestIdRef.current;

        setIsLoadingYtDlpFormats(true);

        const commandParts = [
            "yt-dlp",
            "-v",
            "--ignore-config",
            "--no-playlist",
            "--dump-single-json",
            "--no-warnings",
        ];

        if (cookiesPath) {
            // The cookies file path can reveal the local username/profile layout, and this
            // preview is shown in the terminal and may be pasted into a bug report. Redact
            // the value, mirroring the backend's redacted_args_for_log. The real path is
            // still passed to listYtDlpFormats below.
            commandParts.push("--cookies", "<redacted>");
        } else if (cookiesBrowser) {
            commandParts.push("--cookies-from-browser", cookiesBrowser);
        }

        commandParts.push(url);

        onTerminalStart?.(FORMAT_LOADER_RUN_ID, commandParts.join(" "));
        onTerminalLog?.("Loading formats...");

        try {
            const result = await listYtDlpFormats(
                url,
                cookiesBrowser || null,
                cookiesPath || null
            );

            // A newer request (or a reset from a URL change) superseded this one; discard the
            // stale response instead of overwriting the current formats/selection.
            if (requestId !== latestRequestIdRef.current) {
                return;
            }

            for (const line of result.terminal_logs ?? []) {
                onTerminalLog?.(line);
            }

            const rawFormats = result.formats ?? [];
            const nextFormats = buildMergedFormats(rawFormats);
            const nextSelectedFormatId = inferPreferredFormatId(nextFormats);
            const nextMediaType = inferSelectedMediaType(nextFormats, nextSelectedFormatId);

            setYtDlpFormats(nextFormats);
            setSelectedYtDlpFormatIdState(nextSelectedFormatId);
            onMediaTypeResolved(nextMediaType);

            const currentTitle = getCurrentTitle().trim();
            const suggestedTitle = result.suggested_title?.trim() ?? "";

            if (!currentTitle && suggestedTitle) {
                onSuggestedTitle(suggestedTitle);
            }

            onTerminalLog?.(`Formats loaded successfully: ${nextFormats.length}`);

            if (rawFormats.some((item) => item.has_video && !item.has_audio)) {
                onTerminalLog?.("Merged video + audio options were generated automatically.");
            }

            if (nextSelectedFormatId) {
                onTerminalLog?.(`Selected default format: ${nextSelectedFormatId}`);
            } else {
                onTerminalLog?.("No compatible formats were returned.");
            }
        } catch (error) {
            // A stale request's failure must not clear the current state or surface an error
            // for a URL the user already moved away from.
            if (requestId !== latestRequestIdRef.current) {
                return;
            }

            setYtDlpFormats([]);
            setSelectedYtDlpFormatIdState("");
            onMediaTypeResolved("video");

            let message = resolveErrorMessage(
                error,
                "Failed to load yt-dlp formats."
            );

            if (
                typeof error === "object" &&
                error !== null &&
                "details" in error &&
                typeof (error as { details?: unknown }).details === "string" &&
                (error as { details?: string }).details?.trim()
            ) {
                message = `${message}\n${(error as { details: string }).details.trim()}`;
            }

            onTerminalLog?.(`ERROR: ${message}`);
            throw error;
        } finally {
            setIsLoadingYtDlpFormats(false);
            onTerminalStop?.();
        }
    }, [
        getCookiesBrowser,
        getCookiesPath,
        getCurrentTitle,
        getUrl,
        isLoadingYtDlpFormats,
        onMediaTypeResolved,
        onSuggestedTitle,
        onTerminalLog,
        onTerminalStart,
        onTerminalStop,
        resetYtDlpFormats,
    ]);

    return {
        ytDlpFormats,
        selectedYtDlpFormatId,
        isLoadingYtDlpFormats,
        selectedYtDlpMediaType,
        setSelectedYtDlpFormatId,
        resetYtDlpFormats,
        loadYtDlpFormats,
    };
}