import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("../services/thumbnail-service", () => ({
    resolveDisplayThumbnails: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { resolveDisplayThumbnails } from "../services/thumbnail-service";
import { logError } from "../utils/app-logger";
import { useDisplayThumbnails } from "./use-display-thumbnails";

describe("useDisplayThumbnails", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts empty so the first paint uses the stored thumbnails", () => {
        // The point of the hook is that nothing waits on it: the grid renders immediately with what
        // it already had, and derivatives arrive afterwards.
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(new Map());

        const { result } = renderHook(() =>
            useDisplayThumbnails(["thumbnails/thumb_a.jpg"], "/library")
        );

        expect(result.current.size).toBe(0);
    });

    it("exposes the resolved derivatives keyed by the stored path", async () => {
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(
            new Map([["thumbnails/thumb_a.jpg", "/cache/a.jpg"]])
        );

        const { result } = renderHook(() =>
            useDisplayThumbnails(["thumbnails/thumb_a.jpg"], "/library")
        );

        await waitFor(() => {
            expect(result.current.get("thumbnails/thumb_a.jpg")).toBe("/cache/a.jpg");
        });
    });

    it("keeps earlier pages resolved when a new page is appended", async () => {
        // The regression this guards is visible and ugly: the grid paginates, so replacing the map
        // per page would swap every already-resolved card back to its full-size thumbnail mid-scroll
        // - the opposite of what the hook is for.
        vi.mocked(resolveDisplayThumbnails)
            .mockResolvedValueOnce(new Map([["thumbnails/thumb_a.jpg", "/cache/a.jpg"]]))
            .mockResolvedValueOnce(new Map([["thumbnails/thumb_b.jpg", "/cache/b.jpg"]]));

        const { result, rerender } = renderHook(
            ({ paths }: { paths: string[] }) => useDisplayThumbnails(paths, "/library"),
            { initialProps: { paths: ["thumbnails/thumb_a.jpg"] } }
        );

        await waitFor(() => {
            expect(result.current.get("thumbnails/thumb_a.jpg")).toBe("/cache/a.jpg");
        });

        rerender({ paths: ["thumbnails/thumb_a.jpg", "thumbnails/thumb_b.jpg"] });

        await waitFor(() => {
            expect(result.current.get("thumbnails/thumb_b.jpg")).toBe("/cache/b.jpg");
        });

        expect(result.current.get("thumbnails/thumb_a.jpg")).toBe("/cache/a.jpg");
    });

    it("does not re-resolve when a re-render asks about the same paths", async () => {
        // The grid rebuilds this array on every render of its parent, which an active download makes
        // several times a second. Keying on the contents rather than the array identity is what keeps
        // that from becoming a stream of IPC calls.
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(
            new Map([["thumbnails/thumb_a.jpg", "/cache/a.jpg"]])
        );

        const { rerender } = renderHook(
            ({ paths }: { paths: string[] }) => useDisplayThumbnails(paths, "/library"),
            { initialProps: { paths: ["thumbnails/thumb_a.jpg"] } }
        );

        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(1);
        });

        // A fresh array with identical contents.
        rerender({ paths: ["thumbnails/thumb_a.jpg"] });

        expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(1);
    });

    it("drops everything it resolved when the library path changes", async () => {
        // The derivatives are addressed by content, but the paths they answer are relative to a
        // library that is no longer in use, so carrying them across would map a new library's
        // thumbnail onto an old library's derivative.
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(
            new Map([["thumbnails/thumb_a.jpg", "/cache/a.jpg"]])
        );

        const { result, rerender } = renderHook(
            ({ libraryPath }: { libraryPath: string }) =>
                useDisplayThumbnails(["thumbnails/thumb_a.jpg"], libraryPath),
            { initialProps: { libraryPath: "/library" } }
        );

        await waitFor(() => {
            expect(result.current.size).toBe(1);
        });

        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(new Map());
        rerender({ libraryPath: "/other-library" });

        await waitFor(() => {
            expect(result.current.size).toBe(0);
        });
    });

    it("never asks when there is no library or nothing to resolve", () => {
        const { rerender } = renderHook(
            ({ paths, libraryPath }: { paths: string[]; libraryPath: string }) =>
                useDisplayThumbnails(paths, libraryPath),
            { initialProps: { paths: [] as string[], libraryPath: "/library" } }
        );

        rerender({ paths: ["thumbnails/thumb_a.jpg"], libraryPath: "   " });

        expect(resolveDisplayThumbnails).not.toHaveBeenCalled();
    });

    it("logs a failure and leaves the grid on the stored thumbnails", async () => {
        // Purely an optimization, so a failure must never surface as an error to the user - the
        // cards are already rendering something correct.
        vi.mocked(resolveDisplayThumbnails).mockRejectedValue(new Error("ffmpeg is missing"));

        const { result } = renderHook(() =>
            useDisplayThumbnails(["thumbnails/thumb_a.jpg"], "/library")
        );

        await waitFor(() => {
            expect(logError).toHaveBeenCalled();
        });

        expect(result.current.size).toBe(0);
    });

    it("ignores a resolution that lands after the hook is unmounted", async () => {
        // A channel switch unmounts the grid while a resolve is in flight; setting state then is a
        // no-op in React 18+, but the guard keeps the intent explicit and the test pins it.
        let settle: (value: ReadonlyMap<string, string>) => void = () => {};
        vi.mocked(resolveDisplayThumbnails).mockReturnValue(
            new Promise((resolve) => {
                settle = resolve;
            })
        );

        const { unmount } = renderHook(() =>
            useDisplayThumbnails(["thumbnails/thumb_a.jpg"], "/library")
        );

        unmount();

        await act(async () => {
            settle(new Map([["thumbnails/thumb_a.jpg", "/cache/a.jpg"]]));
        });

        expect(logError).not.toHaveBeenCalled();
    });
});
