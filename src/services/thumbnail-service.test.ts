import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

import { invokeCommand } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { resolveDisplayThumbnails } from "./thumbnail-service";
import type { DisplayThumbnail } from "../types/generated/DisplayThumbnail";

const resolved = (path: string): DisplayThumbnail => ({ kind: "resolved", path });
const budgetSpent: DisplayThumbnail = { kind: "budgetSpent" };
const unavailable: DisplayThumbnail = { kind: "unavailable" };

describe("resolveDisplayThumbnails", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("maps each answer back onto the path that asked for it", async () => {
        // The backend answers positionally, so this zip is the whole contract: an off-by-one here
        // would put one media's derivative on another media's card, which reads as the grid showing
        // the wrong thumbnails rather than as a bug in a cache.
        vi.mocked(invokeCommand).mockResolvedValueOnce([
            resolved("/cache/thumb-display/aaa.jpg"),
            unavailable,
            resolved("/cache/thumb-display/ccc.jpg"),
        ]);

        const { displayPaths } = await resolveDisplayThumbnails(
            ["thumbnails/thumb_aaa.jpg", "thumbnails/thumb_bbb.jpg", "thumbnails/thumb_ccc.jpg"],
            "/library"
        );

        expect(displayPaths.get("thumbnails/thumb_aaa.jpg")).toBe("/cache/thumb-display/aaa.jpg");
        expect(displayPaths.get("thumbnails/thumb_ccc.jpg")).toBe("/cache/thumb-display/ccc.jpg");
        // No derivative is the ordinary case, so the path is simply absent and the caller keeps
        // rendering the stored file.
        expect(displayPaths.has("thumbnails/thumb_bbb.jpg")).toBe(false);
    });

    it("settles a resolved path and a permanently unavailable one alike", async () => {
        // Both are final answers, and the caller uses this set to decide what to stop asking about.
        // A path with no derivative that will never have one has to be in it just as much as a
        // resolved one. That is the whole point of the backend distinguishing them.
        vi.mocked(invokeCommand).mockResolvedValueOnce([
            resolved("/cache/thumb-display/aaa.jpg"),
            unavailable,
        ]);

        const { settledPaths } = await resolveDisplayThumbnails(
            ["thumbnails/thumb_aaa.jpg", "thumbnails/thumb_bbb.jpg"],
            "/library"
        );

        expect([...settledPaths].sort()).toEqual([
            "thumbnails/thumb_aaa.jpg",
            "thumbnails/thumb_bbb.jpg",
        ]);
    });

    it("leaves a budget-spent path unsettled so it is asked about again", async () => {
        // The one answer that is not final: the path is fine and the source is there, the call just
        // had no generation slots left. Settling it would strand that card on the stored file for
        // the rest of the session.
        vi.mocked(invokeCommand).mockResolvedValueOnce([budgetSpent, unavailable]);

        const { displayPaths, settledPaths } = await resolveDisplayThumbnails(
            ["thumbnails/thumb_aaa.jpg", "thumbnails/thumb_bbb.jpg"],
            "/library"
        );

        expect(displayPaths.size).toBe(0);
        expect([...settledPaths]).toEqual(["thumbnails/thumb_bbb.jpg"]);
    });

    it("does not settle a resolved answer whose path is blank", async () => {
        // A resolved answer carrying nothing usable is a backend contract violation, not a
        // derivative. Settling it would record a path as answered while leaving the card without
        // one, and nothing would ever ask again.
        vi.mocked(invokeCommand).mockResolvedValueOnce([resolved("   ")]);

        const { displayPaths, settledPaths } = await resolveDisplayThumbnails(
            ["thumbnails/thumb_aaa.jpg"],
            "/library"
        );

        expect(displayPaths.size).toBe(0);
        expect(settledPaths.size).toBe(0);
    });

    it("asks about each path once even when several media share a thumbnail", async () => {
        // Thumbnails are content-addressed, so two rows pointing at identical content share one
        // file, and the backend's per-call generation budget must not be spent twice on it.
        vi.mocked(invokeCommand).mockResolvedValueOnce([resolved("/cache/thumb-display/aaa.jpg")]);

        const { displayPaths } = await resolveDisplayThumbnails(
            ["thumbnails/thumb_aaa.jpg", "thumbnails/thumb_aaa.jpg"],
            "/library"
        );

        expect(invokeCommand).toHaveBeenCalledWith(TAURI_COMMANDS.RESOLVE_DISPLAY_THUMBNAILS, {
            relativePaths: ["thumbnails/thumb_aaa.jpg"],
            libraryPath: "/library",
        });
        expect(displayPaths.get("thumbnails/thumb_aaa.jpg")).toBe("/cache/thumb-display/aaa.jpg");
    });

    it("drops blank and missing thumbnail paths before calling the backend", async () => {
        // A media with no thumbnail at all is normal (the card shows a placeholder), so those must
        // not travel as empty strings the backend would have to reject one by one.
        vi.mocked(invokeCommand).mockResolvedValueOnce([resolved("/cache/thumb-display/aaa.jpg")]);

        await resolveDisplayThumbnails(
            [null, undefined, "   ", "  thumbnails/thumb_aaa.jpg  "],
            "/library"
        );

        expect(invokeCommand).toHaveBeenCalledWith(TAURI_COMMANDS.RESOLVE_DISPLAY_THUMBNAILS, {
            relativePaths: ["thumbnails/thumb_aaa.jpg"],
            libraryPath: "/library",
        });
    });

    it("does not call the backend when there is nothing to resolve", async () => {
        expect((await resolveDisplayThumbnails([], "/library")).displayPaths.size).toBe(0);
        expect((await resolveDisplayThumbnails([null, "  "], "/library")).displayPaths.size).toBe(0);
        expect((await resolveDisplayThumbnails(["thumbnails/a.jpg"], "  ")).displayPaths.size).toBe(
            0
        );

        expect(invokeCommand).not.toHaveBeenCalled();
    });

    it("ignores an answer shorter than the request instead of misaligning it", async () => {
        // Defense in depth over the zod array schema at the seam: a truncated response must leave
        // the unanswered paths without a derivative, never shift the remaining answers onto them.
        // and must not settle them either, since nothing was decided about those paths.
        vi.mocked(invokeCommand).mockResolvedValueOnce([resolved("/cache/thumb-display/aaa.jpg")]);

        const { displayPaths, settledPaths } = await resolveDisplayThumbnails(
            ["thumbnails/thumb_aaa.jpg", "thumbnails/thumb_bbb.jpg"],
            "/library"
        );

        expect(displayPaths.get("thumbnails/thumb_aaa.jpg")).toBe("/cache/thumb-display/aaa.jpg");
        expect(displayPaths.has("thumbnails/thumb_bbb.jpg")).toBe(false);
        expect(settledPaths.has("thumbnails/thumb_bbb.jpg")).toBe(false);
    });
});
