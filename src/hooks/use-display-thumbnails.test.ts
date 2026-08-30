import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("../services/thumbnail-service", () => ({
    resolveDisplayThumbnails: vi.fn(),
}));

vi.mock("../utils/app-logger", () => ({
    logError: vi.fn(),
}));

import { resolveDisplayThumbnails } from "../services/thumbnail-service";
import type { DisplayThumbnailResolution } from "../services/thumbnail-service";
import { logError } from "../utils/app-logger";
import { useDisplayThumbnails } from "./use-display-thumbnails";

/**
 * A resolution where every listed path resolved to a derivative. The common case, and the one where
 * "settled" and "has a derivative" coincide, which is exactly why the two have to be given
 * separately in the tests below that pull them apart.
 */
function resolvedAll(entries: Record<string, string>): DisplayThumbnailResolution {
    return {
        displayPaths: new Map(Object.entries(entries)),
        settledPaths: new Set(Object.keys(entries)),
    };
}

/** A resolution where nothing resolved and nothing was settled. Every path is worth asking again. */
function retryable(): DisplayThumbnailResolution {
    return { displayPaths: new Map(), settledPaths: new Set() };
}

/** A resolution where the listed paths will never have a derivative, so asking again is pointless. */
function permanentlyUnavailable(paths: string[]): DisplayThumbnailResolution {
    return { displayPaths: new Map(), settledPaths: new Set(paths) };
}

describe("useDisplayThumbnails", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("starts empty so the first paint uses the stored thumbnails", () => {
        // The point of the hook is that nothing waits on it. The grid renders immediately with what
        // it already had, and derivatives arrive afterwards.
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(retryable());

        const { result } = renderHook(() =>
            useDisplayThumbnails(["thumbnails/thumb_a.jpg"], "/library")
        );

        expect(result.current.size).toBe(0);
    });

    it("exposes the resolved derivatives keyed by the stored path", async () => {
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(
            resolvedAll({ "thumbnails/thumb_a.jpg": "/cache/a.jpg" })
        );

        const { result } = renderHook(() =>
            useDisplayThumbnails(["thumbnails/thumb_a.jpg"], "/library")
        );

        await waitFor(() => {
            expect(result.current.get("thumbnails/thumb_a.jpg")).toBe("/cache/a.jpg");
        });
    });

    it("keeps earlier pages resolved when a new page is appended", async () => {
        // The regression this guards is visible and ugly. The grid paginates, so replacing the map
        // per page would swap every already-resolved card back to its full-size thumbnail mid-scroll
        // (the opposite of what the hook is for).
        vi.mocked(resolveDisplayThumbnails)
            .mockResolvedValueOnce(resolvedAll({ "thumbnails/thumb_a.jpg": "/cache/a.jpg" }))
            .mockResolvedValueOnce(resolvedAll({ "thumbnails/thumb_b.jpg": "/cache/b.jpg" }));

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
            resolvedAll({ "thumbnails/thumb_a.jpg": "/cache/a.jpg" })
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

    it("asks only about the paths that are not settled yet", async () => {
        // Every request used to carry every loaded path, so appending page k re-asked about all k
        // pages and the backend paid a stat per entry to answer "already cached". Quadratic in the
        // number of pages, for an answer this side already had. Only the new page is unsettled.
        vi.mocked(resolveDisplayThumbnails)
            .mockResolvedValueOnce(resolvedAll({ "thumbnails/thumb_a.jpg": "/cache/a.jpg" }))
            .mockResolvedValueOnce(resolvedAll({ "thumbnails/thumb_b.jpg": "/cache/b.jpg" }));

        const { rerender } = renderHook(
            ({ paths }: { paths: string[] }) => useDisplayThumbnails(paths, "/library"),
            { initialProps: { paths: ["thumbnails/thumb_a.jpg"] } }
        );

        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(1);
        });

        rerender({ paths: ["thumbnails/thumb_a.jpg", "thumbnails/thumb_b.jpg"] });

        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(2);
        });

        expect(resolveDisplayThumbnails).toHaveBeenLastCalledWith(
            ["thumbnails/thumb_b.jpg"],
            "/library"
        );
    });

    it("asks again about a path the backend left unsettled", async () => {
        // The retryable miss, and it has to stay retryable. The backend caps how many derivatives one
        // call may generate, so a page whose misses hit that ceiling only ever gets them by being
        // asked a second time. Skipping on "was requested" rather than on "was settled" would strand
        // those cards on the stored file forever.
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(retryable());

        const { rerender } = renderHook(
            ({ paths }: { paths: string[] }) => useDisplayThumbnails(paths, "/library"),
            { initialProps: { paths: ["thumbnails/thumb_a.jpg"] } }
        );

        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(1);
        });

        rerender({ paths: ["thumbnails/thumb_a.jpg", "thumbnails/thumb_b.jpg"] });

        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(2);
        });

        expect(resolveDisplayThumbnails).toHaveBeenLastCalledWith(
            ["thumbnails/thumb_a.jpg", "thumbnails/thumb_b.jpg"],
            "/library"
        );
    });

    it("asks again on its own when a request settled nothing and the item list will not change", async () => {
        // The gap this closes. The backend admits one resolve call at a time and answers a refused
        // one entirely "retryable", and its note on that says the caller already re-asks, which was
        // true of the case it was written for and not of the case that produces it. The request key
        // is derived from the items, so a re-ask otherwise needs a page to be appended, and the last
        // page of a channel has no later append behind it. Without a timer of its own, that page
        // would keep decoding full-resolution stored files for the rest of the session.
        //
        // Fake timers here rather than a real wait. The delay is the behavior under test, so the
        // test should assert it fires rather than sleep for it.
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            vi.mocked(resolveDisplayThumbnails).mockResolvedValue(retryable());

            renderHook(() => useDisplayThumbnails(["thumbnails/thumb_a.jpg"], "/library"));

            await waitFor(() => {
                expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(1);
            });

            // Nothing about the props changed, so the old behavior would stop here forever.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(2000);
            });

            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(2);
            expect(resolveDisplayThumbnails).toHaveBeenLastCalledWith(
                ["thumbnails/thumb_a.jpg"],
                "/library"
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("gives up re-asking once the retry budget is spent", async () => {
        // The bound, and it is what keeps the retry above from being a background timer for the rest
        // of the session. Contention clears in a round or two (the call holding the slot finishes),
        // so a request still settling nothing after that is not contended, it is one the backend
        // cannot answer (a machine where FFmpeg hangs). Polling that forever re-derives the same
        // answer at a cost, while stopping costs one session of drawing the stored thumbnail, which
        // is the fallback this hook already declares.
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            vi.mocked(resolveDisplayThumbnails).mockResolvedValue(retryable());

            renderHook(() => useDisplayThumbnails(["thumbnails/thumb_a.jpg"], "/library"));

            await waitFor(() => {
                expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(1);
            });

            // Far more time than the budget allows retries for.
            for (let round = 0; round < 8; round += 1) {
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(2000);
                });
            }

            // The first call plus the three retries the budget allows, and nothing after that.
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(4);
        } finally {
            vi.useRealTimers();
        }
    });

    it("gives a newly appended page a fresh retry budget", async () => {
        // The counter is per request, not per hook. A page that exhausted its retries must not leave
        // the next one unable to retry at all. That would turn a transient stretch of contention
        // into a permanent loss of the feature for the rest of the session, which is a worse version
        // of the bug the retry was added to fix.
        vi.useFakeTimers({ shouldAdvanceTime: true });

        try {
            vi.mocked(resolveDisplayThumbnails).mockResolvedValue(retryable());

            const { rerender } = renderHook(
                ({ paths }: { paths: string[] }) => useDisplayThumbnails(paths, "/library"),
                { initialProps: { paths: ["thumbnails/thumb_a.jpg"] } }
            );

            for (let round = 0; round < 8; round += 1) {
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(2000);
                });
            }

            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(4);

            rerender({ paths: ["thumbnails/thumb_a.jpg", "thumbnails/thumb_b.jpg"] });

            await waitFor(() => {
                expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(5);
            });

            // The append's own call, then its own three retries.
            for (let round = 0; round < 8; round += 1) {
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(2000);
                });
            }

            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(8);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops asking about a path that can never have a derivative", async () => {
        // The other half of the same decision, and the one this change added. A path the backend
        // settled without resolving (a name this app did not write, a machine with no FFmpeg, a
        // source that is gone) must drop out of every later request. Without this it rode along on
        // every page append, which is the quadratic growth the hook exists to prevent and, past the
        // backend's per-call ceiling, a truncation warning per page.
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(
            permanentlyUnavailable(["thumbnails/thumb_a.jpg"])
        );

        const { rerender } = renderHook(
            ({ paths }: { paths: string[] }) => useDisplayThumbnails(paths, "/library"),
            { initialProps: { paths: ["thumbnails/thumb_a.jpg"] } }
        );

        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(1);
        });

        rerender({ paths: ["thumbnails/thumb_a.jpg", "thumbnails/thumb_b.jpg"] });

        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(2);
        });

        // Only the new path. The unavailable one is settled and never travels again.
        expect(resolveDisplayThumbnails).toHaveBeenLastCalledWith(
            ["thumbnails/thumb_b.jpg"],
            "/library"
        );
    });

    it("records the settled paths even when the call resolved no derivative at all", async () => {
        // The ordering that makes the case above work. A call answering only "unavailable" produces
        // an empty derivative map, and returning early on that (which is where the early return used
        // to sit) would throw the settled set away and re-ask about all of them on the next page.
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(
            permanentlyUnavailable(["thumbnails/thumb_a.jpg", "thumbnails/thumb_b.jpg"])
        );

        const { rerender } = renderHook(
            ({ paths }: { paths: string[] }) => useDisplayThumbnails(paths, "/library"),
            { initialProps: { paths: ["thumbnails/thumb_a.jpg", "thumbnails/thumb_b.jpg"] } }
        );

        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(1);
        });

        rerender({
            paths: ["thumbnails/thumb_a.jpg", "thumbnails/thumb_b.jpg", "thumbnails/thumb_c.jpg"],
        });

        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenCalledTimes(2);
        });

        expect(resolveDisplayThumbnails).toHaveBeenLastCalledWith(
            ["thumbnails/thumb_c.jpg"],
            "/library"
        );
    });

    it("drops everything it settled when the library path changes", async () => {
        // The derivatives are addressed by content, but the paths they answer are relative to a
        // library that is no longer in use, so carrying them across would map a new library's
        // thumbnail onto an old library's derivative. The settled set has to be cleared with the map,
        // or a path marked unavailable under the old library would never be asked about under the
        // new one, where it may resolve perfectly well.
        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(
            resolvedAll({ "thumbnails/thumb_a.jpg": "/cache/a.jpg" })
        );

        const { result, rerender } = renderHook(
            ({ libraryPath }: { libraryPath: string }) =>
                useDisplayThumbnails(["thumbnails/thumb_a.jpg"], libraryPath),
            { initialProps: { libraryPath: "/library" } }
        );

        await waitFor(() => {
            expect(result.current.size).toBe(1);
        });

        vi.mocked(resolveDisplayThumbnails).mockResolvedValue(retryable());
        rerender({ libraryPath: "/other-library" });

        await waitFor(() => {
            expect(result.current.size).toBe(0);
        });

        // Asked about again under the new library rather than skipped as already settled.
        await waitFor(() => {
            expect(resolveDisplayThumbnails).toHaveBeenLastCalledWith(
                ["thumbnails/thumb_a.jpg"],
                "/other-library"
            );
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
        // Purely an optimization, so a failure must never surface as an error to the user. The
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
        // A channel switch unmounts the grid while a resolve is in flight. Setting state then is a
        // no-op in React 18+, but the guard keeps the intent explicit and the test pins it.
        let settle: (value: DisplayThumbnailResolution) => void = () => {};
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
            settle(resolvedAll({ "thumbnails/thumb_a.jpg": "/cache/a.jpg" }));
        });

        expect(logError).not.toHaveBeenCalled();
    });
});
