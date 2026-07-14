import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "../lib/tauri-client";
import {
    EVENT_YT_DLP_CANCELLED,
    EVENT_YT_DLP_ERROR,
    EVENT_YT_DLP_FINISHED,
    EVENT_YT_DLP_LOG,
    EVENT_YT_DLP_TERMINAL,
} from "../constants/events";
import { listenTauri } from "../lib/tauri-client";
import { logError } from "../utils/app-logger";
import type {
    YtDlpFailedEvent,
    YtDlpFinishedEvent,
    YtDlpLogEvent,
    YtDlpTerminalEvent,
} from "../types/media";
import { useMemoObject } from "./use-memo-object";

// The error and cancelled events carry the same payload shape.
type YtDlpErrorEvent = YtDlpFailedEvent;
type YtDlpCancelledEvent = YtDlpFailedEvent;

type UseYtDlpEventsReturn = {
    ytDlpLogs: string[];
    isYtDlpRunning: boolean;
    currentRunIdRef: React.MutableRefObject<string>;
    startRun: (runId: string, commandPreview: string) => void;
    startManualSession: (runId: string, header: string) => void;
    appendManualLog: (line: string) => void;
    markStopped: () => void;
    resetYtDlpState: (clearLogs?: boolean) => void;
};

const MAX_YT_DLP_LOG_LINES = 500;

function normalizeLogChunks(input: string): string[] {
    if (!input) {
        return [];
    }

    const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return normalized.split("\n");
}

function isProgressLine(line: string): boolean {
    const normalized = line.trim();

    if (!normalized) {
        return false;
    }

    return (
        normalized.startsWith("[download]") ||
        normalized.startsWith("[ExtractAudio]") ||
        normalized.startsWith("[Merger]") ||
        normalized.startsWith("[Metadata]") ||
        normalized.startsWith("[EmbedThumbnail]") ||
        normalized.startsWith("[ThumbnailsConvertor]")
    );
}

function appendProcessedLogs(current: string[], incoming: string[]): string[] {
    const next = [...current];

    for (const rawLine of incoming) {
        const line = rawLine.replace(/\t/g, "    ");

        if (!line && next[next.length - 1] === "") {
            continue;
        }

        const lastLine = next[next.length - 1];

        if (line === lastLine) {
            continue;
        }

        if (isProgressLine(line) && lastLine && isProgressLine(lastLine)) {
            next[next.length - 1] = line;
            continue;
        }

        next.push(line);
    }

    return next.slice(-MAX_YT_DLP_LOG_LINES);
}

export function useYtDlpEvents(): UseYtDlpEventsReturn {
    const [ytDlpLogs, setYtDlpLogs] = useState<string[]>([]);
    const [isYtDlpRunning, setIsYtDlpRunning] = useState(false);

    const currentRunIdRef = useRef("");
    const listenersRegisteredRef = useRef(false);

    const appendLogs = useCallback((...lines: string[]): void => {
        setYtDlpLogs((current) => {
            let next = current;

            for (const entry of lines) {
                const chunks = normalizeLogChunks(entry);
                next = appendProcessedLogs(next, chunks);
            }

            return next;
        });
    }, []);

    const appendManualLog = useCallback(
        (line: string): void => {
            appendLogs(line);
        },
        [appendLogs]
    );

    const resetYtDlpState = useCallback((clearLogs = false): void => {
        currentRunIdRef.current = "";
        setIsYtDlpRunning(false);

        if (clearLogs) {
            setYtDlpLogs([]);
        }
    }, []);

    const startRun = useCallback((runId: string, commandPreview: string): void => {
        currentRunIdRef.current = runId;
        setYtDlpLogs([commandPreview, ""]);
        setIsYtDlpRunning(true);
    }, []);

    const startManualSession = useCallback((runId: string, header: string): void => {
        currentRunIdRef.current = runId;
        setYtDlpLogs([header, ""]);
        setIsYtDlpRunning(true);
    }, []);

    const markStopped = useCallback((): void => {
        currentRunIdRef.current = "";
        setIsYtDlpRunning(false);
    }, []);

    const finalizeRun = useCallback(
        (message?: string): void => {
            if (message) {
                appendLogs("", message);
            }

            currentRunIdRef.current = "";
            setIsYtDlpRunning(false);
        },
        [appendLogs]
    );

    useEffect(() => {
        if (listenersRegisteredRef.current) {
            return;
        }

        listenersRegisteredRef.current = true;

        let isDisposed = false;
        const unlisteners: UnlistenFn[] = [];

        void (async () => {
            try {
                const unlistenLog = await listenTauri<YtDlpLogEvent>(EVENT_YT_DLP_LOG, (event) => {
                    const currentRunId = currentRunIdRef.current;

                    if (!currentRunId || event.payload.run_id !== currentRunId) {
                        return;
                    }

                    appendLogs(event.payload.line);
                });

                if (isDisposed) {
                    unlistenLog();
                } else {
                    unlisteners.push(unlistenLog);
                }

                const unlistenFinished = await listenTauri<YtDlpFinishedEvent>(
                    EVENT_YT_DLP_FINISHED,
                    (event) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || event.payload.run_id !== currentRunId) {
                            return;
                        }

                        finalizeRun(`Download finished: ${event.payload.file_path}`);
                    }
                );

                if (isDisposed) {
                    unlistenFinished();
                } else {
                    unlisteners.push(unlistenFinished);
                }

                const unlistenError = await listenTauri<YtDlpErrorEvent>(
                    EVENT_YT_DLP_ERROR,
                    (event) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || event.payload.run_id !== currentRunId) {
                            return;
                        }

                        finalizeRun(`ERROR: ${event.payload.message}`);
                    }
                );

                if (isDisposed) {
                    unlistenError();
                } else {
                    unlisteners.push(unlistenError);
                }

                const unlistenCancelled = await listenTauri<YtDlpCancelledEvent>(
                    EVENT_YT_DLP_CANCELLED,
                    (event) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || event.payload.run_id !== currentRunId) {
                            return;
                        }

                        finalizeRun(`Cancelled: ${event.payload.message}`);
                    }
                );

                if (isDisposed) {
                    unlistenCancelled();
                } else {
                    unlisteners.push(unlistenCancelled);
                }

                const unlistenTerminal = await listenTauri<YtDlpTerminalEvent>(
                    EVENT_YT_DLP_TERMINAL,
                    (event) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || event.payload.run_id !== currentRunId) {
                            return;
                        }

                        if (event.payload.status === "finished") {
                            if (event.payload.file_path?.trim()) {
                                finalizeRun(`Terminal finished: ${event.payload.file_path}`);
                                return;
                            }

                            finalizeRun("Terminal finished.");
                            return;
                        }

                        if (event.payload.status === "failed") {
                            finalizeRun(
                                `Terminal failed: ${event.payload.message?.trim() || "Unknown failure"}`
                            );
                            return;
                        }

                        if (event.payload.status === "cancelled") {
                            finalizeRun(
                                `Terminal cancelled: ${event.payload.message?.trim() || "Cancelled"}`
                            );
                        }
                    }
                );

                if (isDisposed) {
                    unlistenTerminal();
                } else {
                    unlisteners.push(unlistenTerminal);
                }
            } catch (error) {
                logError("yt-dlp-events", "Failed to register yt-dlp listeners.", error);
            }
        })();

        return () => {
            isDisposed = true;

            for (const unlisten of unlisteners) {
                unlisten();
            }

            listenersRegisteredRef.current = false;
        };
    }, [appendLogs, finalizeRun]);

    // Memoized so the controller object keeps a stable identity across renders. Consumers that
    // depend on the whole object stop being invalidated on unrelated re-renders.
    return useMemoObject({
        ytDlpLogs,
        isYtDlpRunning,
        currentRunIdRef,
        startRun,
        startManualSession,
        appendManualLog,
        markStopped,
        resetYtDlpState,
    });
}