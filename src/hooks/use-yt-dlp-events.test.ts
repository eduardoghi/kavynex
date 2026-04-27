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

const eventHandlers = new Map<string, (event: { payload: any }) => void>();

vi.mock("../lib/tauri-client", () => ({
    listenTauri: vi.fn(async (eventName: string, handler: (event: { payload: any }) => void) => {
        eventHandlers.set(eventName, handler);
        return vi.fn();
    }),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

function emit(eventName: string, payload: any): void {
    const handler = eventHandlers.get(eventName);

    if (!handler) {
        throw new Error(`Missing handler for event: ${eventName}`);
    }

    handler({ payload });
}

describe("useYtDlpEvents", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
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
        expect(result.current.ytDlpLogs).toEqual([
            "yt-dlp https://youtube.com/watch?v=abc",
            "",
        ]);
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

        expect(result.current.ytDlpLogs).toContain("Downloading...");
        expect(result.current.ytDlpLogs).not.toContain("ignore me");
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

        const logsAfterFinished = [...result.current.ytDlpLogs];

        act(() => {
            emit(EVENT_YT_DLP_TERMINAL, {
                run_id: "run-1",
                status: "finished",
                file_path: "/tmp/video.mp4",
            });
        });

        expect(result.current.ytDlpLogs).toEqual(logsAfterFinished);
        expect(
            result.current.ytDlpLogs.filter((line) => line.includes("finished"))
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
        expect(result.current.ytDlpLogs).toContain("Terminal failed: Network error");
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
        expect(result.current.ytDlpLogs).toContain("ERROR: Download failed");
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
        expect(result.current.ytDlpLogs).toContain("Cancelled: User cancelled");
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

        const logsBeforeLateEvent = [...result.current.ytDlpLogs];

        act(() => {
            emit(EVENT_YT_DLP_LOG, {
                run_id: "run-1",
                line: "late line",
                stream: "stdout",
            });
        });

        expect(result.current.ytDlpLogs).toEqual(logsBeforeLateEvent);
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
        expect(result.current.ytDlpLogs).toEqual([]);
    });
});