import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryVerification } from "./use-library-verification";
import type { ContentVerificationReport } from "../types/generated/ContentVerificationReport";

vi.mock("../services/library-service", () => ({
    verifyLibraryContent: vi.fn(),
    cancelLibraryVerification: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({ logError: vi.fn() }));

import { cancelLibraryVerification, verifyLibraryContent } from "../services/library-service";
import { logError } from "../utils/app-logger";

const verifyMock = vi.mocked(verifyLibraryContent);
const cancelMock = vi.mocked(cancelLibraryVerification);

function report(overrides: Partial<ContentVerificationReport> = {}): ContentVerificationReport {
    return {
        checked: 3,
        verified: 3,
        corrupt: 0,
        corruptExamples: [],
        unverifiable: 0,
        unverifiableExamples: [],
        unreadable: 0,
        unreadableExamples: [],
        cancelled: false,
        ...overrides,
    };
}

describe("useLibraryVerification", () => {
    beforeEach(() => {
        verifyMock.mockReset();
        cancelMock.mockReset();
    });

    it("starts idle", () => {
        const { result } = renderHook(() => useLibraryVerification());

        expect(result.current.running).toBe(false);
        expect(result.current.progress).toBeNull();
        expect(result.current.result).toBeNull();
    });

    it("reports progress while running and the report when it finishes", async () => {
        verifyMock.mockImplementation(async (_path, onProgress) => {
            onProgress(1, 4);
            onProgress(3, 4);
            return report({ checked: 4, verified: 4 });
        });

        const { result } = renderHook(() => useLibraryVerification());

        await act(async () => {
            await result.current.verify("/library");
        });

        expect(verifyMock).toHaveBeenCalledWith("/library", expect.any(Function));
        expect(result.current.result).toEqual({
            status: "done",
            report: report({ checked: 4, verified: 4 }),
        });
        // Cleared when the run ends, so a finished dialog does not keep showing a stale bar.
        expect(result.current.running).toBe(false);
        expect(result.current.progress).toBeNull();
    });

    it("keeps a cancelled run's report rather than treating it as a failure", async () => {
        // The backend answers a cancel with a normal report carrying `cancelled: true`, and the
        // distinction matters: a partial result is not an error, and it is also not a clean bill of
        // health. The hook has to hand both facts to the UI.
        verifyMock.mockResolvedValue(report({ checked: 1, verified: 1, cancelled: true }));

        const { result } = renderHook(() => useLibraryVerification());

        await act(async () => {
            await result.current.verify("/library");
        });

        expect(result.current.result).toEqual({
            status: "done",
            report: report({ checked: 1, verified: 1, cancelled: true }),
        });
    });

    it("surfaces a failure as a message and stops running", async () => {
        verifyMock.mockRejectedValue(new Error("boom"));

        const { result } = renderHook(() => useLibraryVerification());

        await act(async () => {
            await result.current.verify("/library");
        });

        expect(result.current.result?.status).toBe("error");
        expect(result.current.running).toBe(false);
        expect(logError).toHaveBeenCalled();
    });

    it("ignores a second start while one is already in flight", async () => {
        // The backend refuses a concurrent run, but that refusal would reach the user as an error
        // about a verification already running, which is a confusing way to report a double click.
        let release: (value: ContentVerificationReport) => void = () => {};
        verifyMock.mockImplementation(
            () =>
                new Promise<ContentVerificationReport>((resolve) => {
                    release = resolve;
                })
        );

        const { result } = renderHook(() => useLibraryVerification());

        let first: Promise<void> = Promise.resolve();
        act(() => {
            first = result.current.verify("/library");
        });

        await waitFor(() => expect(result.current.running).toBe(true));

        await act(async () => {
            await result.current.verify("/library");
        });

        expect(verifyMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            release(report());
            await first;
        });

        expect(result.current.running).toBe(false);
    });

    it("asks the backend to stop and swallows a failed cancel", async () => {
        // A failed cancel is worth a log line and not an error dialog stacked on top of a check that
        // is still working: the run either stops or finishes, and either way the report is what the
        // user sees.
        cancelMock.mockRejectedValue(new Error("nope"));

        const { result } = renderHook(() => useLibraryVerification());

        await act(async () => {
            await result.current.cancel();
        });

        expect(cancelMock).toHaveBeenCalled();
        expect(result.current.result).toBeNull();
        expect(logError).toHaveBeenCalled();
    });
});
