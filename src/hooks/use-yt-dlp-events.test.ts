import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    EVENT_YT_DLP_CANCELLED,
    EVENT_YT_DLP_ERROR,
    EVENT_YT_DLP_FINISHED,
    EVENT_YT_DLP_LOG,
    EVENT_YT_DLP_TERMINAL,
} from "../constants/events";
import { useYtDlpEvents } from "./use-yt-dlp-events";

// The hook now stores each line as { id, text } so the terminal can key rows on a stable id. These
// tests assert on the text, so map it out.
function logTexts(logs: readonly { text: string }[]): string[] {
    return logs.map((line) => line.text);
}

const eventHandlers = new Map<string, (payload: any) => void>();
const unlistenMocks = new Map<string, ReturnType<typeof vi.fn>>();

// The hook subscribes through listenValidated (eventName, schema, handler). The schema is exercised
// by the ipc-schemas tests, so this mock ignores it and hands the payload straight to the handler.
vi.mock("../lib/tauri-client", () => ({
    listenValidated: vi.fn(
        async (eventName: string, _schema: unknown, handler: (payload: any) => void) => {
            eventHandlers.set(eventName, handler);
            const unlisten = vi.fn();
            unlistenMocks.set(eventName, unlisten);
            return unlisten;
        }
    ),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { listenValidated } from "../lib/tauri-client";
import { logError } from "../utils/app-logger";

const ALL_EVENTS = [
    EVENT_YT_DLP_LOG,
    EVENT_YT_DLP_FINISHED,
    EVENT_YT_DLP_ERROR,
    EVENT_YT_DLP_CANCELLED,
    EVENT_YT_DLP_TERMINAL,
];

function emit(eventName: string, payload: any): void {
    const handler = eventHandlers.get(eventName);

    if (!handler) {
        throw new Error(`Missing handler for event: ${eventName}`);
    }

    handler(payload);
}

describe("useYtDlpEvents", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        unlistenMocks.clear();
    });

    it("starts a run with command preview", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.size).toBeGreaterThan(0);
        });

        act(() => {
            result.current.startRun("run-1", "yt-dlp https://youtube.com/watch?v=abc");
        });

        expect(result.current.isYtDlpRunning).toBe(true);
        expect(result.current.currentRunIdRef.current).toBe("run-1");
        expect(result.current.terminal.getSnapshot().logs.map((line) => line.text)).toEqual([
            "yt-dlp https://youtube.com/watch?v=abc",
            "",
        ]);
    });

    it("starts a manual session with header and running state", () => {
        const { result } = renderHook(() => useYtDlpEvents());

        act(() => {
            result.current.startManualSession("manual-1", "Manual header");
        });

        expect(result.current.isYtDlpRunning).toBe(true);
        expect(result.current.currentRunIdRef.current).toBe("manual-1");
        expect(logTexts(result.current.terminal.getSnapshot().logs)).toEqual(["Manual header", ""]);
    });

    it("appends log lines only for the current run", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_LOG, {
                run_id: "other-run",
                line: "ignore me",
                stream: "stdout",
            });
        });

        act(() => {
            emit(EVENT_YT_DLP_LOG, {
                run_id: "run-1",
                line: "Downloading...",
                stream: "stdout",
            });
        });

        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Downloading...");
        expect(logTexts(result.current.terminal.getSnapshot().logs)).not.toContain("ignore me");
    });

    it.each(ALL_EVENTS)(
        "ignores %s event when there is no active run at all",
        async (eventName) => {
            const { result } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(eventHandlers.has(eventName)).toBe(true);
            });

            act(() => {
                emit(eventName, {
                    run_id: "run-1",
                    line: "x",
                    message: "x",
                    status: "finished",
                    file_path: "/x",
                });
            });

            expect(result.current.isYtDlpRunning).toBe(false);
            expect(logTexts(result.current.terminal.getSnapshot().logs)).toEqual([]);
        }
    );

    it.each([
        [EVENT_YT_DLP_FINISHED, { run_id: "other", file_path: "/x", suggested_title: "x" }],
        [EVENT_YT_DLP_ERROR, { run_id: "other", message: "err" }],
        [EVENT_YT_DLP_CANCELLED, { run_id: "other", message: "cancel" }],
        [
            EVENT_YT_DLP_TERMINAL,
            {
                run_id: "other",
                status: "finished",
                file_path: "/x",
                message: null,
                suggested_title: null,
            },
        ],
    ])("ignores %s event for a different run id", async (eventName, payload) => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(eventName)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        const logsBefore = [...result.current.terminal.getSnapshot().logs];

        act(() => {
            emit(eventName, payload);
        });

        expect(result.current.isYtDlpRunning).toBe(true);
        expect(result.current.currentRunIdRef.current).toBe("run-1");
        expect(result.current.terminal.getSnapshot().logs).toEqual(logsBefore);
    });

    it("finalizes only once when finished event is followed by terminal finished", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_FINISHED)).toBe(true);
            expect(eventHandlers.has(EVENT_YT_DLP_TERMINAL)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_FINISHED, {
                run_id: "run-1",
                file_path: "/tmp/video.mp4",
                suggested_title: "Video",
            });
        });

        expect(result.current.isYtDlpRunning).toBe(false);
        expect(result.current.currentRunIdRef.current).toBe("");

        const logsAfterFinished = [...result.current.terminal.getSnapshot().logs];

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "finished",
                file_path: "/tmp/video.mp4",
            });
        });

        expect(result.current.terminal.getSnapshot().logs).toEqual(logsAfterFinished);
        expect(result.current.terminal.getSnapshot().outcome).toBe("finished");
        expect(
            result.current.terminal.getSnapshot().logs.filter((line) => line.text.includes("finished"))
        ).toHaveLength(1);
    });

    it("finalizes with terminal failure message", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_TERMINAL)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "failed",
                message: "Network error",
            });
        });

        expect(result.current.isYtDlpRunning).toBe(false);
        expect(result.current.currentRunIdRef.current).toBe("");
        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Terminal failed: Network error");
        expect(result.current.terminal.getSnapshot().outcome).toBe("failed");
    });

    it("terminal failure without a message falls back to a default", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_TERMINAL)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "failed",
                message: null,
            });
        });

        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Terminal failed: Unknown failure");
    });

    it("terminal failure with a whitespace-only message falls back to a default", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_TERMINAL)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "failed",
                message: "   ",
            });
        });

        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Terminal failed: Unknown failure");
    });

    it("terminal finished without a file_path uses a generic message", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_TERMINAL)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "finished",
                file_path: null,
            });
        });

        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Terminal finished.");
        expect(
            result.current.terminal.getSnapshot().logs.some((line) => line.text.startsWith("Terminal finished: "))
        ).toBe(false);
    });

    it("terminal finished with a whitespace-only file_path uses a generic message", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_TERMINAL)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "finished",
                file_path: "   ",
            });
        });

        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Terminal finished.");
    });

    it("terminal finished with a file_path reports it and stops", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_TERMINAL)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "finished",
                file_path: "/tmp/video.mp4",
            });
        });

        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Terminal finished: /tmp/video.mp4");
        expect(result.current.isYtDlpRunning).toBe(false);
    });

    it("terminal cancelled with a message reports it", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_TERMINAL)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "cancelled",
                message: "User stopped it",
            });
        });

        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Terminal cancelled: User stopped it");
        expect(result.current.isYtDlpRunning).toBe(false);
    });

    it("terminal cancelled without a message falls back to a default", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_TERMINAL)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "cancelled",
                message: null,
            });
        });

        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Terminal cancelled: Cancelled");
    });

    it("finalizes with error event message", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_ERROR)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_ERROR, {
                run_id: "run-1",
                message: "Download failed",
            });
        });

        expect(result.current.isYtDlpRunning).toBe(false);
        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("ERROR: Download failed");
    });

    it("finalizes with cancelled event message", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_CANCELLED)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_CANCELLED, {
                run_id: "run-1",
                message: "User cancelled",
            });
        });

        expect(result.current.isYtDlpRunning).toBe(false);
        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("Cancelled: User cancelled");
        expect(result.current.terminal.getSnapshot().outcome).toBe("cancelled");
    });

    it("keeps the outcome markStopped is given until the next run starts", async () => {
        // The case yt-dlp events cannot report, an import that failed after yt-dlp itself finished.
        const { result } = renderHook(() => useYtDlpEvents());

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            result.current.markStopped("failed");
        });

        expect(result.current.terminal.getSnapshot().outcome).toBe("failed");

        act(() => {
            result.current.startRun("run-2", "cmd");
        });

        expect(result.current.terminal.getSnapshot().outcome).toBeNull();

        act(() => {
            result.current.markStopped();
        });

        expect(result.current.terminal.getSnapshot().outcome).toBe("finished");
    });

    it("markStopped stops current run and ignores later events", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            result.current.markStopped();
        });

        expect(result.current.isYtDlpRunning).toBe(false);
        expect(result.current.currentRunIdRef.current).toBe("");

        const logsBeforeLateEvent = [...result.current.terminal.getSnapshot().logs];

        act(() => {
            emit(EVENT_YT_DLP_LOG, {
                run_id: "run-1",
                line: "late line",
                stream: "stdout",
            });
        });

        expect(result.current.terminal.getSnapshot().logs).toEqual(logsBeforeLateEvent);
    });

    it("resetYtDlpState can also clear logs", async () => {
        const { result } = renderHook(() => useYtDlpEvents());

        await waitFor(() => {
            expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
        });

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            emit(EVENT_YT_DLP_LOG, {
                run_id: "run-1",
                line: "Downloading...",
                stream: "stdout",
            });
        });

        act(() => {
            result.current.resetYtDlpState(true);
        });

        expect(result.current.isYtDlpRunning).toBe(false);
        expect(result.current.currentRunIdRef.current).toBe("");
        expect(logTexts(result.current.terminal.getSnapshot().logs)).toEqual([]);
    });

    it("resetYtDlpState without arguments preserves existing logs", () => {
        const { result } = renderHook(() => useYtDlpEvents());

        act(() => {
            result.current.startRun("run-1", "cmd");
        });

        act(() => {
            result.current.resetYtDlpState();
        });

        expect(result.current.isYtDlpRunning).toBe(false);
        expect(result.current.currentRunIdRef.current).toBe("");
        expect(logTexts(result.current.terminal.getSnapshot().logs)).toEqual(["cmd", ""]);
    });

    describe("log line processing", () => {
        it("ignores an empty manual log line", () => {
            const { result } = renderHook(() => useYtDlpEvents());

            act(() => {
                result.current.appendManualLog("first");
            });

            act(() => {
                result.current.appendManualLog("");
            });

            expect(logTexts(result.current.terminal.getSnapshot().logs)).toEqual(["first"]);
        });

        it("splits a multi-line manual log entry on CRLF and CR", () => {
            const { result } = renderHook(() => useYtDlpEvents());

            act(() => {
                result.current.appendManualLog("line1\r\nline2\rline3");
            });

            expect(logTexts(result.current.terminal.getSnapshot().logs)).toEqual(["line1", "line2", "line3"]);
        });

        it("does not duplicate consecutive blank lines", async () => {
            const { result } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
            });

            act(() => {
                result.current.startRun("run-1", "cmd");
            });

            act(() => {
                emit(EVENT_YT_DLP_LOG, { run_id: "run-1", line: "", stream: "stdout" });
            });

            expect(logTexts(result.current.terminal.getSnapshot().logs)).toEqual(["cmd", ""]);
        });

        it("skips a log line identical to the previous one", async () => {
            const { result } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
            });

            act(() => {
                result.current.startRun("run-1", "cmd");
            });

            act(() => {
                emit(EVENT_YT_DLP_LOG, { run_id: "run-1", line: "same line", stream: "stdout" });
            });

            act(() => {
                emit(EVENT_YT_DLP_LOG, { run_id: "run-1", line: "same line", stream: "stdout" });
            });

            expect(
                result.current.terminal.getSnapshot().logs.filter((line) => line.text === "same line")
            ).toHaveLength(1);
        });

        it("replaces tab characters with four spaces", async () => {
            const { result } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
            });

            act(() => {
                result.current.startRun("run-1", "cmd");
            });

            act(() => {
                emit(EVENT_YT_DLP_LOG, { run_id: "run-1", line: "a\tb", stream: "stdout" });
            });

            expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain("a    b");
        });

        it("collapses consecutive percentage lines into the latest one", async () => {
            const { result } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
            });

            act(() => {
                result.current.startRun("run-1", "cmd");
            });

            for (const line of ["[download]  10.0% of 5MiB", "[download]  20.0% of 5MiB"]) {
                act(() => {
                    emit(EVENT_YT_DLP_LOG, { run_id: "run-1", line, stream: "stdout" });
                });
            }

            const progressEntries = logTexts(result.current.terminal.getSnapshot().logs).filter(
                (text) => text.startsWith("[download]")
            );
            expect(progressEntries).toEqual(["[download]  20.0% of 5MiB"]);
        });

        it.each([
            "[download] Destination: youtube_abc_137.f137.mp4",
            "[download] youtube_abc_137.mp4 has already been downloaded",
            '[Merger] Merging formats into "youtube_abc_137.mp4"',
            "[ExtractAudio] Destination: youtube_abc_140.m4a",
            "[Metadata] Adding metadata to \"youtube_abc_137.mp4\"",
        ])("keeps the stage line %s instead of letting the next line replace it", async (stage) => {
            const { result } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
            });

            act(() => {
                result.current.startRun("run-1", "cmd");
            });

            for (const line of ["[download]  99.0% of 5MiB", stage, "[download] 100% of 5MiB"]) {
                act(() => {
                    emit(EVENT_YT_DLP_LOG, { run_id: "run-1", line, stream: "stdout" });
                });
            }

            const logs = logTexts(result.current.terminal.getSnapshot().logs);
            expect(logs).toContain(stage);
            expect(logs).toContain("[download]  99.0% of 5MiB");
            expect(logs[logs.length - 1]).toBe("[download] 100% of 5MiB");
        });

        it("does not collapse a progress line into a non-progress previous line", async () => {
            const { result } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
            });

            act(() => {
                result.current.startRun("run-1", "cmd");
            });

            act(() => {
                emit(EVENT_YT_DLP_LOG, {
                    run_id: "run-1",
                    line: "Starting download",
                    stream: "stdout",
                });
            });

            act(() => {
                emit(EVENT_YT_DLP_LOG, {
                    run_id: "run-1",
                    line: "[download] 10%",
                    stream: "stdout",
                });
            });

            expect(logTexts(result.current.terminal.getSnapshot().logs)).toEqual([
                "cmd",
                "",
                "Starting download",
                "[download] 10%",
            ]);
        });

        it("treats a whitespace-only line as not a progress line", async () => {
            const { result } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(eventHandlers.has(EVENT_YT_DLP_LOG)).toBe(true);
            });

            act(() => {
                result.current.startRun("run-1", "cmd");
            });

            act(() => {
                emit(EVENT_YT_DLP_LOG, {
                    run_id: "run-1",
                    line: "[download] 10%",
                    stream: "stdout",
                });
            });

            act(() => {
                emit(EVENT_YT_DLP_LOG, { run_id: "run-1", line: "   ", stream: "stdout" });
            });

            const logs = logTexts(result.current.terminal.getSnapshot().logs);
            expect(logs[logs.length - 1]).toBe("   ");
            expect(logs).toContain("[download] 10%");
        });

        it("caps stored log lines at the configured maximum", () => {
            const { result } = renderHook(() => useYtDlpEvents());

            act(() => {
                for (let i = 0; i < 520; i += 1) {
                    result.current.appendManualLog(`line-${i}`);
                }
            });

            expect(result.current.terminal.getSnapshot().logs).toHaveLength(500);
            const cappedLogs = logTexts(result.current.terminal.getSnapshot().logs);
            expect(cappedLogs[0]).toBe("line-20");
            expect(cappedLogs[cappedLogs.length - 1]).toBe("line-519");
        });
    });

    describe("listener lifecycle", () => {
        it("calls unlisten for every registered listener on unmount", async () => {
            const { unmount } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(eventHandlers.size).toBe(5);
            });

            unmount();

            for (const eventName of ALL_EVENTS) {
                expect(unlistenMocks.get(eventName)).toHaveBeenCalledTimes(1);
            }
        });

        it("unlistens immediately for a listener that resolves after unmount", async () => {
            let resolveLog: (fn: () => void) => void = () => {};

            vi.mocked(listenValidated).mockImplementationOnce(
                ((eventName: string, _schema: unknown, handler: any) => {
                    eventHandlers.set(eventName, handler);

                    return new Promise((resolve) => {
                        resolveLog = (fn: () => void) => resolve(fn);
                    });
                }) as any
            );

            const { unmount } = renderHook(() => useYtDlpEvents());

            unmount();

            const logUnlisten = vi.fn();

            act(() => {
                resolveLog(logUnlisten);
            });

            await waitFor(() => {
                expect(logUnlisten).toHaveBeenCalledTimes(1);
            });

            await waitFor(() => {
                for (const eventName of [
                    EVENT_YT_DLP_FINISHED,
                    EVENT_YT_DLP_ERROR,
                    EVENT_YT_DLP_CANCELLED,
                    EVENT_YT_DLP_TERMINAL,
                ]) {
                    expect(unlistenMocks.get(eventName)).toHaveBeenCalledTimes(1);
                }
            });
        });

        it("keeps registering the other listeners when one fails, and says so in the next run", async () => {
            vi.mocked(listenValidated).mockRejectedValueOnce(new Error("registration failed"));

            const { result } = renderHook(() => useYtDlpEvents());

            await waitFor(() => {
                expect(logError).toHaveBeenCalledWith(
                    "yt-dlp-events",
                    "Failed to register a yt-dlp listener.",
                    expect.any(Error),
                    { event: expect.any(String) }
                );
            });

            // The first registration failed and the four after it still went through. They are not
            // awaited in series, so one failure does not leave the rest unregistered.
            expect(listenValidated).toHaveBeenCalledTimes(5);

            act(() => {
                result.current.startRun("run-1", "yt-dlp ...");
            });

            expect(
                result.current.terminal
                    .getSnapshot()
                    .logs.some(
                        (line) =>
                            line.level === "warn" && line.text.includes("could not be subscribed to")
                    )
            ).toBe(true);
        });
    });

    it("does not re-render its owner for a log line, only the terminal's subscribers", () => {
        // The owner is the Home page. A download writes several lines a second, and as state each
        // one re-rendered the whole page.
        let renders = 0;
        const { result } = renderHook(() => {
            renders += 1;
            return useYtDlpEvents();
        });
        const listener = vi.fn();
        const unsubscribe = result.current.terminal.subscribe(listener);
        const rendersBefore = renders;

        act(() => {
            result.current.appendManualLog("[download]  42.0% of 10.00MiB");
        });

        expect(renders).toBe(rendersBefore);
        expect(listener).toHaveBeenCalled();
        expect(logTexts(result.current.terminal.getSnapshot().logs)).toContain(
            "[download]  42.0% of 10.00MiB"
        );

        unsubscribe();
    });
});
