import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDatabaseIntegrityCheck } from "./use-database-integrity-check";
import { checkDatabaseIntegrity, rebuildDatabaseIndexes } from "../services/database-service";

vi.mock("../services/database-service", () => ({
    checkDatabaseIntegrity: vi.fn(),
    rebuildDatabaseIndexes: vi.fn(),
}));

describe("useDatabaseIntegrityCheck", () => {
    it("reports an ok result when the check passes", async () => {
        vi.mocked(checkDatabaseIntegrity).mockResolvedValueOnce({
            ok: true,
            problems: [],
            truncated: false,
        });

        const { result } = renderHook(() => useDatabaseIntegrityCheck());

        await act(async () => {
            await result.current.runCheck();
        });

        expect(result.current.result).toEqual({ status: "ok" });
        expect(result.current.loading).toBe(false);
    });

    it("carries the problems and the truncation flag through", async () => {
        vi.mocked(checkDatabaseIntegrity).mockResolvedValueOnce({
            ok: false,
            problems: ["page 1 is damaged"],
            truncated: true,
        });

        const { result } = renderHook(() => useDatabaseIntegrityCheck());

        await act(async () => {
            await result.current.runCheck();
        });

        expect(result.current.result).toEqual({
            status: "problem",
            problems: ["page 1 is damaged"],
            truncated: true,
            rebuilt: false,
        });
    });

    it("reports a rebuild that cleared the damage apart from a plain pass", async () => {
        vi.mocked(rebuildDatabaseIndexes).mockResolvedValueOnce({
            ok: true,
            problems: [],
            truncated: false,
        });

        const { result } = renderHook(() => useDatabaseIntegrityCheck());

        await act(async () => {
            await result.current.rebuildIndexes();
        });

        expect(result.current.result).toEqual({ status: "repaired" });
        expect(result.current.rebuilding).toBe(false);
    });

    it("marks the problems that are left after a rebuild", async () => {
        vi.mocked(rebuildDatabaseIndexes).mockResolvedValueOnce({
            ok: false,
            problems: ["page 9: btreeInitPage() returns error code 11"],
            truncated: false,
        });

        const { result } = renderHook(() => useDatabaseIntegrityCheck());

        await act(async () => {
            await result.current.rebuildIndexes();
        });

        expect(result.current.result).toEqual({
            status: "problem",
            problems: ["page 9: btreeInitPage() returns error code 11"],
            truncated: false,
            rebuilt: true,
        });
    });

    it("maps a failed rebuild to a friendly message", async () => {
        vi.mocked(rebuildDatabaseIndexes).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() => useDatabaseIntegrityCheck());

        await act(async () => {
            await result.current.rebuildIndexes();
        });

        expect(result.current.result).toEqual({
            status: "error",
            message: "Failed to rebuild the indexes.",
        });
    });

    it("maps a thrown command error to a friendly message", async () => {
        vi.mocked(checkDatabaseIntegrity).mockRejectedValueOnce(new Error("boom"));

        const { result } = renderHook(() => useDatabaseIntegrityCheck());

        await act(async () => {
            await result.current.runCheck();
        });

        expect(result.current.result).toEqual({
            status: "error",
            message: "Failed to run the integrity check.",
        });
    });

    it("keeps a stable object identity across renders", async () => {
        const { result, rerender } = renderHook(() => useDatabaseIntegrityCheck());

        const first = result.current;
        rerender();

        await waitFor(() => {
            expect(result.current).toBe(first);
        });
    });
});
