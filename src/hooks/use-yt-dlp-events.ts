import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "../lib/tauri-client";
import {
    EVENT_YT_DLP_CANCELLED,
    EVENT_YT_DLP_ERROR,
    EVENT_YT_DLP_FINISHED,
    EVENT_YT_DLP_LOG,
    EVENT_YT_DLP_TERMINAL,
} from "../constants/events";
import { listenValidated } from "../lib/tauri-client";
import { IPC_EVENT_SCHEMAS } from "../lib/ipc-schemas";
import { logError } from "../utils/app-logger";
import { useMemoObject } from "./use-memo-object";

// One terminal line plus a stable, monotonic id assigned when the line is first appended. The id
// is what the terminal keys its rows on: the scrollback is trimmed from the front at
// MAX_YT_DLP_LOG_LINES, which shifts every array index, so an index-derived key would change
// underneath React and remount the whole 500-row scrollback on each new line past the cap. A per-line
// id never changes once assigned, so React reuses each row and only the genuinely new one mounts.
export type YtDlpLogLine = { id: number; text: string };

type UseYtDlpEventsReturn = {
    ytDlpLogs: YtDlpLogLine[];
    isYtDlpRunning: boolean;
    currentRunIdRef: React.RefObject<string>;
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

// Wraps plain text lines as YtDlpLogLine, numbering them from `startId`. Used to seed a fresh
// session (the command preview / header), where the log starts empty so ids begin at 0.
function toLogLines(texts: string[], startId = 0): YtDlpLogLine[] {
    return texts.map((text, index) => ({ id: startId + index, text }));
}

// The next id to assign. Ids are monotonic and only ever appended at the tail, so the last line
// carries the highest one; deriving from it (rather than a mutable counter) keeps this function
// pure - safe to re-run under StrictMode - and survives the front-trim below, since a line's id
// never changes once assigned.
function nextLogId(lines: YtDlpLogLine[]): number {
    const lastLine = lines[lines.length - 1];
    return lastLine ? lastLine.id + 1 : 0;
}

function appendProcessedLogs(current: YtDlpLogLine[], incoming: string[]): YtDlpLogLine[] {
    const next = [...current];
    let id = nextLogId(current);

    for (const rawLine of incoming) {
        const text = rawLine.replace(/\t/g, "    ");
        const lastLine = next[next.length - 1];

        if (!text && lastLine?.text === "") {
            continue;
        }

        if (text === lastLine?.text) {
            continue;
        }

        if (isProgressLine(text) && lastLine && isProgressLine(lastLine.text)) {
            // Collapse consecutive progress lines by updating the last one in place, keeping its id
            // so React updates that row rather than remounting it.
            next[next.length - 1] = { id: lastLine.id, text };
            continue;
        }

        next.push({ id, text });
        id += 1;
    }

    return next.slice(-MAX_YT_DLP_LOG_LINES);
}

export function useYtDlpEvents(): UseYtDlpEventsReturn {
    const [ytDlpLogs, setYtDlpLogs] = useState<YtDlpLogLine[]>([]);
    const [isYtDlpRunning, setIsYtDlpRunning] = useState(false);

    const currentRunIdRef = useRef("");

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
        setYtDlpLogs(toLogLines([commandPreview, ""]));
        setIsYtDlpRunning(true);
    }, []);

    const startManualSession = useCallback((runId: string, header: string): void => {
        currentRunIdRef.current = runId;
        setYtDlpLogs(toLogLines([header, ""]));
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

    // Registers the yt-dlp event listeners once. The dependencies are stable (appendLogs is
    // useCallback([]); finalizeRun only depends on it), so this effect runs on mount and cleans up on
    // unmount, never re-running in between. React always runs the cleanup before re-running an effect
    // (including StrictMode's mount/unmount/mount in dev), and `isDisposed` plus the unlisteners list
    // are what make that safe: a listener whose async registration resolves after disposal is
    // unlistened immediately, so no duplicate registration outlives a remount.
    useEffect(() => {
        let isDisposed = false;
        const unlisteners: UnlistenFn[] = [];

        void (async () => {
            try {
                const unlistenLog = await listenValidated(
                    EVENT_YT_DLP_LOG,
                    IPC_EVENT_SCHEMAS.ytDlpLog,
                    (payload) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || payload.run_id !== currentRunId) {
                            return;
                        }

                        appendLogs(payload.line);
                    }
                );

                if (isDisposed) {
                    unlistenLog();
                } else {
                    unlisteners.push(unlistenLog);
                }

                const unlistenFinished = await listenValidated(
                    EVENT_YT_DLP_FINISHED,
                    IPC_EVENT_SCHEMAS.ytDlpFinished,
                    (payload) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || payload.run_id !== currentRunId) {
                            return;
                        }

                        finalizeRun(`Download finished: ${payload.file_path}`);
                    }
                );

                if (isDisposed) {
                    unlistenFinished();
                } else {
                    unlisteners.push(unlistenFinished);
                }

                const unlistenError = await listenValidated(
                    EVENT_YT_DLP_ERROR,
                    IPC_EVENT_SCHEMAS.ytDlpFailed,
                    (payload) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || payload.run_id !== currentRunId) {
                            return;
                        }

                        finalizeRun(`ERROR: ${payload.message}`);
                    }
                );

                if (isDisposed) {
                    unlistenError();
                } else {
                    unlisteners.push(unlistenError);
                }

                const unlistenCancelled = await listenValidated(
                    EVENT_YT_DLP_CANCELLED,
                    IPC_EVENT_SCHEMAS.ytDlpFailed,
                    (payload) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || payload.run_id !== currentRunId) {
                            return;
                        }

                        finalizeRun(`Cancelled: ${payload.message}`);
                    }
                );

                if (isDisposed) {
                    unlistenCancelled();
                } else {
                    unlisteners.push(unlistenCancelled);
                }

                const unlistenTerminal = await listenValidated(
                    EVENT_YT_DLP_TERMINAL,
                    IPC_EVENT_SCHEMAS.ytDlpTerminal,
                    (payload) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || payload.run_id !== currentRunId) {
                            return;
                        }

                        if (payload.status === "finished") {
                            if (payload.file_path?.trim()) {
                                finalizeRun(`Terminal finished: ${payload.file_path}`);
                                return;
                            }

                            finalizeRun("Terminal finished.");
                            return;
                        }

                        if (payload.status === "failed") {
                            finalizeRun(
                                `Terminal failed: ${payload.message?.trim() || "Unknown failure"}`
                            );
                            return;
                        }

                        if (payload.status === "cancelled") {
                            finalizeRun(
                                `Terminal cancelled: ${payload.message?.trim() || "Cancelled"}`
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