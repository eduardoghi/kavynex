import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { logError } from "../utils/app-logger";
import { useRunReport } from "./use-run-report";

const FAILURE = { log: "Failed to run the check.", message: "The check could not run." };

describe("useRunReport", () => {
    it("keeps what the task returns as the result", async () => {
        const { result } = renderHook(() => useRunReport<{ status: "ok" }>());

        await act(async () => {
            await result.current.run(async () => ({ status: "ok" }), FAILURE);
        });

        expect(result.current.result).toEqual({ status: "ok" });
    });

    it("turns a thrown error into an error result and logs it", async () => {
        const { result } = renderHook(() => useRunReport<{ status: "ok" }>());
        const error = new Error("boom");

        await act(async () => {
            await result.current.run(async () => {
                throw error;
            }, FAILURE);
        });

        expect(result.current.result).toEqual({ status: "error", message: FAILURE.message });
        expect(logError).toHaveBeenCalledWith("diagnostics", FAILURE.log, error);
    });

    it("clears the previous result while a run works, unless asked to keep it", async () => {
        const { result } = renderHook(() => useRunReport<{ status: "ok" | "again" }>());

        await act(async () => {
            await result.current.run(async () => ({ status: "ok" }), FAILURE);
        });

        let finish: (() => void) | undefined;
        const slow = () =>
            new Promise<{ status: "again" }>((resolve) => {
                finish = () => resolve({ status: "again" });
            });

        let running: Promise<void>;
        act(() => {
            running = result.current.run(slow, FAILURE, true);
        });
        expect(result.current.result).toEqual({ status: "ok" });

        await act(async () => {
            finish?.();
            await running;
        });

        act(() => {
            running = result.current.run(slow, FAILURE);
        });
        expect(result.current.result).toBeNull();

        await act(async () => {
            finish?.();
            await running;
        });
        expect(result.current.result).toEqual({ status: "again" });
    });
});
