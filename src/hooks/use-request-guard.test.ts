import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRequestGuard } from "./use-request-guard";

describe("useRequestGuard", () => {
    it("treats only the most recent begin() as current", () => {
        const { result } = renderHook(() => useRequestGuard());

        let first = 0;
        let second = 0;

        act(() => {
            first = result.current.begin();
            second = result.current.begin();
        });

        expect(second).toBeGreaterThan(first);
        expect(result.current.isCurrent(first)).toBe(false);
        expect(result.current.isCurrent(second)).toBe(true);
    });

    it("invalidate() supersedes an in-flight request without starting a new one", () => {
        const { result } = renderHook(() => useRequestGuard());

        let requestId = 0;

        act(() => {
            requestId = result.current.begin();
        });
        expect(result.current.isCurrent(requestId)).toBe(true);

        act(() => {
            result.current.invalidate();
        });

        // The in-flight request is now stale, and no new request became current.
        expect(result.current.isCurrent(requestId)).toBe(false);
    });

    it("keeps a stable identity across renders", () => {
        const { result, rerender } = renderHook(() => useRequestGuard());

        const firstGuard = result.current;
        rerender();

        expect(result.current).toBe(firstGuard);
        expect(result.current.begin).toBe(firstGuard.begin);
        expect(result.current.isCurrent).toBe(firstGuard.isCurrent);
        expect(result.current.invalidate).toBe(firstGuard.invalidate);
    });
});
