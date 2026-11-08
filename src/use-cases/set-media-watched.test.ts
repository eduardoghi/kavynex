import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/media-service", () => ({
    setMediaWatched: vi.fn(),
    setMediaUnwatched: vi.fn(),
}));

import { setMediaUnwatched, setMediaWatched } from "../services/media-service";
import type { MediaRow } from "../types/media";
import { createMedia } from "../test/factories/media";
import { executeSetMediaWatched } from "./set-media-watched";

function applyTo(items: MediaRow[]) {
    let currentItems = items;
    const updateMediaItems = vi.fn((updater: (items: MediaRow[]) => MediaRow[]) => {
        currentItems = updater(currentItems);
    });

    return { updateMediaItems, current: () => currentItems };
}

describe("executeSetMediaWatched", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("marks only the target media watched and resets its progress", async () => {
        vi.mocked(setMediaWatched).mockResolvedValueOnce("2026-07-11 12:00:00");
        const list = applyTo([
            createMedia({ id: 1, watched_at: null, progress_seconds: 30 }),
            createMedia({ id: 2, watched_at: null, progress_seconds: 40 }),
        ]);

        const change = await executeSetMediaWatched({
            mediaId: 2,
            watched: true,
            updateMediaItems: list.updateMediaItems as never,
        });

        expect(setMediaWatched).toHaveBeenCalledWith(2);
        // The database timestamp returned by the command is what gets written, not a client clock.
        expect(change).toEqual({ watched_at: "2026-07-11 12:00:00", progress_seconds: 0 });
        expect(list.current()[0]).toMatchObject({ watched_at: null, progress_seconds: 30 });
        expect(list.current()[1]).toMatchObject({
            watched_at: "2026-07-11 12:00:00",
            progress_seconds: 0,
        });
    });

    it("marks only the target media unwatched and leaves its progress", async () => {
        vi.mocked(setMediaUnwatched).mockResolvedValueOnce(undefined);
        const list = applyTo([
            createMedia({ id: 1, watched_at: "2026-03-30T12:00:00Z", progress_seconds: 0 }),
            createMedia({ id: 2, watched_at: "2026-03-30T12:00:00Z", progress_seconds: 0 }),
        ]);

        const change = await executeSetMediaWatched({
            mediaId: 1,
            watched: false,
            updateMediaItems: list.updateMediaItems as never,
        });

        expect(setMediaUnwatched).toHaveBeenCalledWith(1);
        expect(setMediaWatched).not.toHaveBeenCalled();
        expect(change).toEqual({ watched_at: null });
        expect(list.current()[0]!.watched_at).toBeNull();
        expect(list.current()[1]!.watched_at).toBe("2026-03-30T12:00:00Z");
    });
});
