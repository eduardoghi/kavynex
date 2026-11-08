import { useCallback, useRef, useState } from "react";
import type { ImportMode } from "../types/settings";
import { createMedia } from "../services/media-service";
import { cancelMediaDownload } from "../services/media-download-service";
import { buildYtDlpCommandPreview, generateYtDlpRunId } from "../use-cases/add-media";
import { YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE } from "../constants/error-codes";
import { parseAppError } from "../utils/app-error";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";
import { useMemoObject } from "./use-memo-object";

// The pause between two media of a batch, so YouTube sees one download after another the way a
// person adding them by hand would make them, rather than a burst.
export const BATCH_PAUSE_MS = 5000;

export type BatchImportItem = {
    youtubeVideoId: string;
    title: string;
    // The format chosen for it, among the ones its listing offered (see useBatchFormats).
    formatId: string;
};

export type BatchImportOptions = {
    downloadComments: boolean;
    downloadLiveChat: boolean;
    // How yt-dlp signs in, resolved the way the add-media form resolves it (resolveCookiesSource).
    // Both null for no cookies.
    cookiesBrowser: string | null;
    cookiesPath: string | null;
};

export type BatchItemStatus = "waiting" | "downloading" | "done" | "failed" | "stopped";

export type BatchItemState = BatchImportItem & {
    status: BatchItemStatus;
    // Why it failed, or a note on a media that was added with something missing.
    message: string | null;
};

export type BatchImportController = {
    // The channel the batch adds to, or null before the first batch.
    channelId: number | null;
    items: BatchItemState[];
    isRunning: boolean;
    isStopping: boolean;
    // Adds `items` to channel `channelId`, one at a time with BATCH_PAUSE_MS between them.
    start: (
        channelId: number,
        items: BatchImportItem[],
        options: BatchImportOptions
    ) => Promise<void>;
    // Stops the media in progress and starts no other. What was added stays.
    stop: () => void;
    // Starts the media that failed again, in the formats and with the options the batch had.
    retryFailed: () => Promise<void>;
    // Forgets a finished batch, so its summary goes.
    clear: () => void;
};

type UseBatchImportOptions = {
    importMode: ImportMode;
    libraryPath: string;
    // The add-media flag, so a batch blocks what a single add blocks (a second add, deleting the
    // channel, moving the library) and the other way round.
    runAddMedia: <T>(task: () => Promise<T>) => Promise<T | undefined>;
    // The add-media terminal, which shows the download in progress.
    startRun: (runId: string, commandPreview: string) => void;
    appendManualLog: (line: string) => void;
    onReloadMedia: () => Promise<void>;
};

function isCancellation(error: unknown): boolean {
    return parseAppError(error).code === YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE;
}

// Resolves after `ms`, or as soon as `signal` aborts.
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

// A batch of the media a channel has on YouTube and the library does not, added one after another
// the way the add-media form adds one, each in the format the user chose for it. A media that fails
// is reported and the batch goes on with the next.
export function useBatchImport({
    importMode,
    libraryPath,
    runAddMedia,
    startRun,
    appendManualLog,
    onReloadMedia,
}: UseBatchImportOptions): BatchImportController {
    const [channelId, setChannelId] = useState<number | null>(null);
    const [items, setItems] = useState<BatchItemState[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [isStopping, setIsStopping] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    // What the last batch ran with, for retryFailed.
    const lastRunRef = useRef<{ channelId: number; options: BatchImportOptions } | null>(null);
    // The run in progress (a download or its comment backup), which a stop cancels by id.
    const runIdRef = useRef("");

    const setItem = useCallback(
        (index: number, status: BatchItemStatus, message: string | null = null): void => {
            setItems((current) =>
                current.map((item, at) => (at === index ? { ...item, status, message } : item))
            );
        },
        []
    );

    const importOne = useCallback(
        async (
            channel: number,
            item: BatchImportItem,
            index: number,
            options: BatchImportOptions
        ): Promise<void> => {
            const url = `https://www.youtube.com/watch?v=${item.youtubeVideoId}`;

            setItem(index, "downloading");
            const downloadRunId = generateYtDlpRunId();
            const commentsRunId = generateYtDlpRunId();
            runIdRef.current = downloadRunId;
            startRun(
                downloadRunId,
                buildYtDlpCommandPreview(
                    url,
                    options.cookiesBrowser,
                    options.cookiesPath,
                    item.formatId
                )
            );
            appendManualLog(`Batch: ${index + 1}. ${item.title}`);

            const created = await createMedia(
                {
                    channelId: channel,
                    title: item.title,
                    sourceMode: "yt-dlp",
                    sourceValue: url,
                    thumbnailSourcePath: null,
                    importMode,
                    libraryPath,
                    publishedAt: null,
                    ytDlpRunId: downloadRunId,
                    ytDlpFormatId: item.formatId,
                    ytDlpYoutubeVideoId: item.youtubeVideoId,
                    downloadComments: options.downloadComments,
                    downloadLiveChat: options.downloadLiveChat,
                    cookiesBrowser: options.cookiesBrowser,
                    cookiesPath: options.cookiesPath,
                },
                {
                    onProgress: appendManualLog,
                    commentsRunId,
                    onCommentsFetchChange: (fetching) => {
                        runIdRef.current = fetching ? commentsRunId : "";
                    },
                }
            );

            setItem(
                index,
                "done",
                created.comments === "failed" ? "Added, but its comments could not be saved." : null
            );
        },
        [appendManualLog, importMode, libraryPath, setItem, startRun]
    );

    const start = useCallback(
        async (
            channel: number,
            batch: BatchImportItem[],
            options: BatchImportOptions
        ): Promise<void> => {
            if (batch.length === 0) {
                return;
            }

            lastRunRef.current = { channelId: channel, options };

            await runAddMedia(async () => {
                const controller = new AbortController();
                abortRef.current = controller;
                setChannelId(channel);
                setItems(batch.map((item) => ({ ...item, status: "waiting", message: null })));
                setIsRunning(true);
                setIsStopping(false);

                try {
                    for (const [index, item] of batch.entries()) {
                        if (controller.signal.aborted) {
                            setItem(index, "stopped");
                            continue;
                        }

                        try {
                            await importOne(channel, item, index, options);
                        } catch (error) {
                            if (isCancellation(error) || controller.signal.aborted) {
                                setItem(index, "stopped");
                                continue;
                            }

                            logError("batch-import", "Failed to add a media of a batch.", error, {
                                channelId: channel,
                                youtubeVideoId: item.youtubeVideoId,
                            });
                            setItem(
                                index,
                                "failed",
                                resolveErrorMessage(error, "The media could not be added.")
                            );
                        } finally {
                            runIdRef.current = "";
                        }

                        if (index < batch.length - 1) {
                            await pause(BATCH_PAUSE_MS, controller.signal);
                        }
                    }
                } finally {
                    abortRef.current = null;
                    setIsRunning(false);
                    setIsStopping(false);
                    // Once, at the end, rather than after each media. A failure here costs the grid
                    // its refresh and nothing else, and the media list says so itself.
                    await onReloadMedia().catch(() => undefined);
                }
            });
        },
        [importOne, onReloadMedia, runAddMedia, setItem]
    );

    const stop = useCallback((): void => {
        const controller = abortRef.current;

        if (!controller || controller.signal.aborted) {
            return;
        }

        controller.abort();
        setIsStopping(true);

        const runId = runIdRef.current;

        if (runId) {
            // Best effort. A run that ended meanwhile is not registered any more, and the loop
            // starts nothing after the abort either way.
            void cancelMediaDownload(runId).catch(() => undefined);
        }
    }, []);

    const retryFailed = useCallback(async (): Promise<void> => {
        const lastRun = lastRunRef.current;
        const failed = items
            .filter((item) => item.status === "failed")
            .map(({ youtubeVideoId, title, formatId }) => ({ youtubeVideoId, title, formatId }));

        if (lastRun && failed.length > 0) {
            await start(lastRun.channelId, failed, lastRun.options);
        }
    }, [items, start]);

    const clear = useCallback((): void => {
        if (abortRef.current) {
            return;
        }

        setItems([]);
        setChannelId(null);
    }, []);

    return useMemoObject({
        channelId,
        items,
        isRunning,
        isStopping,
        start,
        stop,
        retryFailed,
        clear,
    });
}
