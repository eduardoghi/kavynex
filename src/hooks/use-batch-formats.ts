import { useCallback, useEffect, useRef, useState } from "react";
import { cancelMediaDownload, listYtDlpFormats } from "../services/media-download-service";
import {
    buildMergedFormats,
    inferPreferredAudioFormatId,
    inferPreferredFormatId,
    inferPreferredFormatIdUpTo,
} from "../services/yt-dlp-format-rules";
import type { YtDlpFormat, YtDlpFormatOption } from "../types/media";
import { generateYtDlpRunId } from "../use-cases/add-media";
import { YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE } from "../constants/error-codes";
import { parseAppError } from "../utils/app-error";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";
import { useMemoObject } from "./use-memo-object";

// The pause between two format listings. Each is one request to YouTube, lighter than a download,
// and a short gap still keeps a long selection from reading as a burst.
export const FORMATS_PAUSE_MS = 1500;

// A rule that picks a format for every media of a batch at once, which the user then changes per
// media as they like. "best" is what the add-media form pre-selects, a height caps the video at it,
// and "audio" is the best audio-only format.
export type BatchQuality = "best" | "1080" | "720" | "480" | "360" | "audio";

// The format `quality` names among a media's formats (built by buildMergedFormats), or "".
export function pickBatchFormatId(formats: YtDlpFormat[], quality: BatchQuality): string {
    if (quality === "audio") {
        return inferPreferredAudioFormatId(formats);
    }

    if (quality === "best") {
        return inferPreferredFormatId(formats);
    }

    return inferPreferredFormatIdUpTo(formats, Number(quality));
}

export type BatchFormatsEntry = {
    status: "waiting" | "loading" | "loaded" | "failed";
    formats: YtDlpFormatOption[];
    selectedFormatId: string;
    // The title yt-dlp gives the media, which the batch saves it under.
    title: string | null;
    error: string | null;
};

export type BatchFormatsMedia = {
    youtubeVideoId: string;
    title: string;
};

export type BatchFormatsCookies = {
    cookiesBrowser: string | null;
    cookiesPath: string | null;
};

export type BatchFormatsController = {
    // By YouTube video id.
    entries: ReadonlyMap<string, BatchFormatsEntry>;
    isLoading: boolean;
    // Lists the formats of each media in turn, FORMATS_PAUSE_MS apart, and pre-selects one by
    // `quality`. A listing still running is stopped first.
    loadAll: (
        media: BatchFormatsMedia[],
        cookies: BatchFormatsCookies,
        quality: BatchQuality
    ) => Promise<void>;
    retry: (
        media: BatchFormatsMedia,
        cookies: BatchFormatsCookies,
        quality: BatchQuality
    ) => Promise<void>;
    selectFormat: (youtubeVideoId: string, formatId: string) => void;
    // Picks by `quality` for every media whose formats are loaded.
    preselectAll: (quality: BatchQuality) => void;
    // Forgets every listing, after the sign-in changed (it changes which formats are offered).
    reset: () => void;
};

function isCancellation(error: unknown): boolean {
    return parseAppError(error).code === YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }

        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true }
        );
    });
}

// The formats of each media picked for a batch, listed the way the add-media form lists one, so the
// user chooses one per media before the batch downloads them.
export function useBatchFormats(): BatchFormatsController {
    const [entries, setEntries] = useState<ReadonlyMap<string, BatchFormatsEntry>>(new Map());
    const [isLoading, setIsLoading] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const runIdRef = useRef("");

    const setEntry = useCallback(
        (youtubeVideoId: string, update: (entry: BatchFormatsEntry) => BatchFormatsEntry): void => {
            setEntries((current) => {
                const next = new Map(current);
                const entry = next.get(youtubeVideoId) ?? {
                    status: "waiting",
                    formats: [],
                    selectedFormatId: "",
                    title: null,
                    error: null,
                };
                next.set(youtubeVideoId, update(entry));
                return next;
            });
        },
        []
    );

    const loadOne = useCallback(
        async (
            media: BatchFormatsMedia,
            cookies: BatchFormatsCookies,
            quality: BatchQuality,
            signal: AbortSignal
        ): Promise<void> => {
            setEntry(media.youtubeVideoId, (entry) => ({
                ...entry,
                status: "loading",
                error: null,
            }));
            const runId = `batch-formats-${generateYtDlpRunId()}`;
            runIdRef.current = runId;

            try {
                const listed = await listYtDlpFormats(
                    `https://www.youtube.com/watch?v=${media.youtubeVideoId}`,
                    cookies.cookiesBrowser,
                    cookies.cookiesPath,
                    runId
                );

                if (signal.aborted) {
                    return;
                }

                const formats = buildMergedFormats(listed.formats ?? []);
                setEntry(media.youtubeVideoId, () => ({
                    status: formats.length > 0 ? "loaded" : "failed",
                    formats,
                    selectedFormatId: pickBatchFormatId(formats, quality),
                    title: listed.suggested_title?.trim() || null,
                    error: formats.length > 0 ? null : "No format was offered.",
                }));
            } catch (error) {
                if (signal.aborted || isCancellation(error)) {
                    setEntry(media.youtubeVideoId, (entry) => ({ ...entry, status: "waiting" }));
                    return;
                }

                logError("batch-import", "Failed to list the formats of a batch media.", error, {
                    youtubeVideoId: media.youtubeVideoId,
                });
                setEntry(media.youtubeVideoId, (entry) => ({
                    ...entry,
                    status: "failed",
                    error: resolveErrorMessage(error, "The formats could not be loaded."),
                }));
            } finally {
                runIdRef.current = "";
            }
        },
        [setEntry]
    );

    const stop = useCallback((): void => {
        abortRef.current?.abort();
        abortRef.current = null;

        const runId = runIdRef.current;
        runIdRef.current = "";

        if (runId) {
            void cancelMediaDownload(runId).catch(() => undefined);
        }
    }, []);

    const run = useCallback(
        async (
            media: BatchFormatsMedia[],
            cookies: BatchFormatsCookies,
            quality: BatchQuality
        ): Promise<void> => {
            stop();
            const controller = new AbortController();
            abortRef.current = controller;
            setIsLoading(true);

            try {
                for (const [index, item] of media.entries()) {
                    if (controller.signal.aborted) {
                        return;
                    }

                    await loadOne(item, cookies, quality, controller.signal);

                    if (index < media.length - 1) {
                        await pause(FORMATS_PAUSE_MS, controller.signal);
                    }
                }
            } finally {
                if (abortRef.current === controller) {
                    abortRef.current = null;
                    setIsLoading(false);
                }
            }
        },
        [loadOne, stop]
    );

    const loadAll = useCallback(
        async (
            media: BatchFormatsMedia[],
            cookies: BatchFormatsCookies,
            quality: BatchQuality
        ): Promise<void> => {
            setEntries(
                new Map(
                    media.map((item) => [
                        item.youtubeVideoId,
                        {
                            status: "waiting",
                            formats: [],
                            selectedFormatId: "",
                            title: null,
                            error: null,
                        },
                    ])
                )
            );
            await run(media, cookies, quality);
        },
        [run]
    );

    const retry = useCallback(
        (media: BatchFormatsMedia, cookies: BatchFormatsCookies, quality: BatchQuality) =>
            run([media], cookies, quality),
        [run]
    );

    const selectFormat = useCallback(
        (youtubeVideoId: string, formatId: string): void => {
            setEntry(youtubeVideoId, (entry) => ({ ...entry, selectedFormatId: formatId }));
        },
        [setEntry]
    );

    const preselectAll = useCallback((quality: BatchQuality): void => {
        setEntries((current) => {
            const next = new Map(current);

            for (const [id, entry] of current) {
                if (entry.status === "loaded") {
                    next.set(id, {
                        ...entry,
                        selectedFormatId: pickBatchFormatId(entry.formats, quality),
                    });
                }
            }

            return next;
        });
    }, []);

    const reset = useCallback((): void => {
        stop();
        setIsLoading(false);
        setEntries(new Map());
    }, [stop]);

    // A listing still running when the panel closes is stopped, not left to finish for nobody.
    useEffect(() => stop, [stop]);

    return useMemoObject({
        entries,
        isLoading,
        loadAll,
        retry,
        selectFormat,
        preselectAll,
        reset,
    });
}
