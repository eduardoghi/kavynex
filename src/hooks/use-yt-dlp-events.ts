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
import {
    createYtDlpTerminalStore,
    type YtDlpRunOutcome,
    type YtDlpTerminalStore,
} from "./yt-dlp-terminal-store";
import type { DownloadLogLevel } from "../types/generated/DownloadLogLevel";
import {
    advanceYtDlpProgress,
    parseYtDlpProgress,
    type YtDlpProgress,
} from "../services/yt-dlp-progress";

// How a line is classified, reused verbatim from the backend's own generated union rather than
// respelled here, so a level added on the Rust side is a type error in the terminal's colour map
// instead of a line that silently renders as the fallback.
export type YtDlpLogLevel = DownloadLogLevel;

// One terminal line plus a stable, monotonic id assigned when the line is first appended. The id
// is what the terminal keys its rows on. The scrollback is trimmed from the front at
// MAX_YT_DLP_LOG_LINES, which shifts every array index, so an index-derived key would change
// underneath React and remount the whole 500-row scrollback on each new line past the cap. A per-line
// id never changes once assigned, so React reuses each row and only the genuinely new one mounts.
//
// `level` is the backend's own classification, carried through rather than re-derived. The log
// event already validates it (`ipc-schemas.ts`), and the terminal used to ignore it and sniff the
// text for an `ERROR:` prefix instead.
export type YtDlpLogLine = { id: number; text: string; level: YtDlpLogLevel };

type UseYtDlpEventsReturn = {
    // The terminal's lines, and how far the run has got (null until something reports a stage).
    // The progress is derived from the same lines, so it needs no second event. Both live in a store
    // rather than in this hook's state, so a log line re-renders only what subscribes to it (see
    // yt-dlp-terminal-store.ts). The store's identity never changes.
    terminal: YtDlpTerminalStore;
    isYtDlpRunning: boolean;
    currentRunIdRef: React.RefObject<string>;
    startRun: (runId: string, commandPreview: string) => void;
    startManualSession: (runId: string, header: string) => void;
    appendManualLog: (line: string) => void;
    // `outcome` is "finished" unless the caller says otherwise. Only the caller knows a run that
    // threw after yt-dlp exited (registering the media, say) failed, since yt-dlp itself finished.
    markStopped: (outcome?: YtDlpRunOutcome) => void;
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

// A percentage line (`[download]  42.0% of ...`), the only kind that replaces the one before it.
// yt-dlp prints several a second and only the latest says anything. Every other line stays, a
// `[download] Destination:`, a "has already been downloaded" or a `[Merger]` step included, since
// those are what a pasted log needs.
function isProgressLine(line: string): boolean {
    return (parseYtDlpProgress(line)?.percent ?? null) !== null;
}

// Wraps plain text lines as YtDlpLogLine, numbering them from `startId`. Used to seed a fresh
// session (the command preview / header), where the log starts empty so ids begin at 0.
function toLogLines(
    texts: string[],
    startId = 0,
    level: YtDlpLogLevel = "info"
): YtDlpLogLine[] {
    return texts.map((text, index) => ({ id: startId + index, text, level }));
}

// Shown at the top of each run while one of the event listeners failed to register (see the effect
// that registers them), so a log that stops early or a progress bar that never moves comes with a
// reason instead of looking like a stalled download.
const LISTENER_FAILURE_WARNING =
    "Some download events could not be subscribed to, so this log and the progress may stay incomplete. Restart Kavynex if this keeps happening.";

// The lines a new session starts with.
function sessionLines(header: string, listenerFailed: boolean): YtDlpLogLine[] {
    const lines = toLogLines([header, ""]);

    return listenerFailed
        ? [...lines, ...toLogLines([LISTENER_FAILURE_WARNING, ""], lines.length, "warn")]
        : lines;
}

// The next id to assign. Ids are monotonic and only ever appended at the tail, so the last line
// carries the highest one; deriving from it (rather than a mutable counter) keeps this function
// pure (safe to re-run under StrictMode), and survives the front-trim below, since a line's id
// never changes once assigned.
function nextLogId(lines: YtDlpLogLine[]): number {
    const lastLine = lines[lines.length - 1];
    return lastLine ? lastLine.id + 1 : 0;
}

function appendProcessedLogs(
    current: YtDlpLogLine[],
    incoming: string[],
    level: YtDlpLogLevel
): YtDlpLogLine[] {
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
            next[next.length - 1] = { id: lastLine.id, text, level };
            continue;
        }

        next.push({ id, text, level });
        id += 1;
    }

    return next.slice(-MAX_YT_DLP_LOG_LINES);
}

function setLogs(
    terminal: YtDlpTerminalStore,
    change: YtDlpLogLine[] | ((current: YtDlpLogLine[]) => YtDlpLogLine[])
): void {
    terminal.update((current) => ({
        ...current,
        logs: typeof change === "function" ? change(current.logs) : change,
    }));
}

function setProgress(
    terminal: YtDlpTerminalStore,
    change: YtDlpProgress | null | ((current: YtDlpProgress | null) => YtDlpProgress | null)
): void {
    terminal.update((current) => {
        const progress = typeof change === "function" ? change(current.progress) : change;

        return progress === current.progress ? current : { ...current, progress };
    });
}

function setOutcome(terminal: YtDlpTerminalStore, outcome: YtDlpRunOutcome | null): void {
    terminal.update((current) => (current.outcome === outcome ? current : { ...current, outcome }));
}

export function useYtDlpEvents(): UseYtDlpEventsReturn {
    const [terminal] = useState(createYtDlpTerminalStore);
    const [isYtDlpRunning, setIsYtDlpRunning] = useState(false);

    const currentRunIdRef = useRef("");
    // Set when a yt-dlp event listener failed to register. Read when a session starts, so the warning
    // goes at the top of the log the user is looking at.
    const listenerFailedRef = useRef(false);

    // The level is a required first argument rather than one defaulting to "info", because every
    // caller genuinely knows it. A backend line carries its own, and an app-generated one is a
    // deliberate choice. A default would let the interesting cases (a failure notice, a warning)
    // fall back to "info" by omission, which is the bug this replaced.
    const appendLogs = useCallback(
        (level: YtDlpLogLevel, ...lines: string[]): void => {
            const chunks = lines.flatMap(normalizeLogChunks);

            setLogs(terminal, (current) => appendProcessedLogs(current, chunks, level));

            // Folded outside the log updater rather than inside it. A state updater has to stay
            // pure (StrictMode runs it twice), and a second setState there would be a side effect
            // in a reducer. Reading the same chunks twice is free next to that.
            setProgress(terminal, (current) =>
                chunks.reduce<YtDlpProgress | null>(
                    (progress, line) => advanceYtDlpProgress(progress, line),
                    current
                )
            );
        },
        [terminal]
    );

    const appendManualLog = useCallback(
        (line: string): void => {
            appendLogs("info", line);
        },
        [appendLogs]
    );

    const resetYtDlpState = useCallback(
        (clearLogs = false): void => {
            currentRunIdRef.current = "";
            setIsYtDlpRunning(false);
            setProgress(terminal, null);
            setOutcome(terminal, null);

            if (clearLogs) {
                setLogs(terminal, []);
            }
        },
        [terminal]
    );

    const startRun = useCallback(
        (runId: string, commandPreview: string): void => {
            currentRunIdRef.current = runId;
            setLogs(terminal, sessionLines(commandPreview, listenerFailedRef.current));
            setIsYtDlpRunning(true);
            setProgress(terminal, null);
            setOutcome(terminal, null);
        },
        [terminal]
    );

    const startManualSession = useCallback(
        (runId: string, header: string): void => {
            currentRunIdRef.current = runId;
            setLogs(terminal, sessionLines(header, listenerFailedRef.current));
            setIsYtDlpRunning(true);
            setProgress(terminal, null);
            setOutcome(terminal, null);
        },
        [terminal]
    );

    const markStopped = useCallback(
        (outcome: YtDlpRunOutcome = "finished"): void => {
            currentRunIdRef.current = "";
            setIsYtDlpRunning(false);
            setProgress(terminal, null);
            setOutcome(terminal, outcome);
        },
        [terminal]
    );

    // `level` is required, and it is what replaced the terminal's old `startsWith("ERROR:")` check.
    // That sniff only ever matched one of these outcomes (the yt-dlp error event, whose text
    // happens to start with the prefix), so a terminal-failed line rendered as ordinary output. The
    // caller knows which outcome it is reporting, so it says so.
    const finalizeRun = useCallback(
        (message: string, level: YtDlpLogLevel, outcome: YtDlpRunOutcome): void => {
            if (message) {
                appendLogs(level, "", message);
            }

            currentRunIdRef.current = "";
            setIsYtDlpRunning(false);
            setProgress(terminal, null);
            setOutcome(terminal, outcome);
        },
        [appendLogs, terminal]
    );

    // Registers the yt-dlp event listeners once. The dependencies are stable (appendLogs is
    // useCallback([]); finalizeRun only depends on it), so this effect runs on mount and cleans up on
    // unmount, never re-running in between. React always runs the cleanup before re-running an effect
    // (including StrictMode's mount/unmount/mount in dev), and `isDisposed` plus the unlisteners list
    // are what make that safe. A listener whose async registration resolves after disposal is
    // unlistened immediately, so no duplicate registration outlives a remount.
    useEffect(() => {
        let isDisposed = false;
        const unlisteners: UnlistenFn[] = [];

        // Each listener is registered on its own and the results are collected with allSettled. They
        // used to be awaited one after another inside a single try, so the first one to fail left
        // every later one unregistered (a terminal that never hears "finished"), with nothing but a
        // log line to say so.
        const registrations: [string, () => Promise<UnlistenFn>][] = [
            [
                EVENT_YT_DLP_LOG,
                () =>
                    listenValidated(EVENT_YT_DLP_LOG, IPC_EVENT_SCHEMAS.ytDlpLog, (payload) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || payload.run_id !== currentRunId) {
                            return;
                        }

                        appendLogs(payload.level, payload.line);
                    }),
            ],
            [
                EVENT_YT_DLP_FINISHED,
                () =>
                    listenValidated(
                        EVENT_YT_DLP_FINISHED,
                        IPC_EVENT_SCHEMAS.ytDlpFinished,
                        (payload) => {
                            const currentRunId = currentRunIdRef.current;

                            if (!currentRunId || payload.run_id !== currentRunId) {
                                return;
                            }

                            finalizeRun(`Download finished: ${payload.file_path}`, "info", "finished");
                        }
                    ),
            ],
            [
                EVENT_YT_DLP_ERROR,
                () =>
                    listenValidated(EVENT_YT_DLP_ERROR, IPC_EVENT_SCHEMAS.ytDlpFailed, (payload) => {
                        const currentRunId = currentRunIdRef.current;

                        if (!currentRunId || payload.run_id !== currentRunId) {
                            return;
                        }

                        finalizeRun(`ERROR: ${payload.message}`, "error", "failed");
                    }),
            ],
            [
                EVENT_YT_DLP_CANCELLED,
                () =>
                    listenValidated(
                        EVENT_YT_DLP_CANCELLED,
                        IPC_EVENT_SCHEMAS.ytDlpFailed,
                        (payload) => {
                            const currentRunId = currentRunIdRef.current;

                            if (!currentRunId || payload.run_id !== currentRunId) {
                                return;
                            }

                            finalizeRun(`Cancelled: ${payload.message}`, "info", "cancelled");
                        }
                    ),
            ],
            [
                EVENT_YT_DLP_TERMINAL,
                () =>
                    listenValidated(
                        EVENT_YT_DLP_TERMINAL,
                        IPC_EVENT_SCHEMAS.ytDlpTerminal,
                        (payload) => {
                            const currentRunId = currentRunIdRef.current;

                            if (!currentRunId || payload.run_id !== currentRunId) {
                                return;
                            }

                            if (payload.status === "finished") {
                                if (payload.file_path?.trim()) {
                                    finalizeRun(
                                        `Terminal finished: ${payload.file_path}`,
                                        "info",
                                        "finished"
                                    );
                                    return;
                                }

                                finalizeRun("Terminal finished.", "info", "finished");
                                return;
                            }

                            if (payload.status === "failed") {
                                finalizeRun(
                                    `Terminal failed: ${payload.message?.trim() || "Unknown failure"}`,
                                    "error",
                                    "failed"
                                );
                                return;
                            }

                            if (payload.status === "cancelled") {
                                finalizeRun(
                                    `Terminal cancelled: ${payload.message?.trim() || "Cancelled"}`,
                                    "info",
                                    "cancelled"
                                );
                            }
                        }
                    ),
            ],
        ];

        void (async () => {
            const results = await Promise.allSettled(
                registrations.map(([, register]) => register())
            );

            results.forEach((result, index) => {
                if (result.status === "fulfilled") {
                    if (isDisposed) {
                        result.value();
                    } else {
                        unlisteners.push(result.value);
                    }

                    return;
                }

                listenerFailedRef.current = true;
                logError("yt-dlp-events", "Failed to register a yt-dlp listener.", result.reason, {
                    event: registrations[index]?.[0],
                });
            });
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
        terminal,
        isYtDlpRunning,
        currentRunIdRef,
        startRun,
        startManualSession,
        appendManualLog,
        markStopped,
        resetYtDlpState,
    });
}