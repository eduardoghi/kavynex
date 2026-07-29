import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

import { invokeCommand } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { resolveDisplayThumbnails } from "./thumbnail-service";

describe("resolveDisplayThumbnails", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("maps each answer back onto the path that asked for it", async () => {
        // The backend answers positionally, so this zip is the whole contract: an off-by-one here
        // would put one media's derivative on another media's card, which reads as the grid showing
        // the wrong thumbnails rather than as a bug in a cache.
        vi.mocked(invokeCommand).mockResolvedValueOnce([
            "/cache/thumb-display/aaa.jpg",
            null,
            "/cache/thumb-display/ccc.jpg",
        ]);

        const resolved = await resolveDisplayThumbnails(
            ["thumbnails/thumb_aaa.jpg", "thumbnails/thumb_bbb.jpg", "thumbnails/thumb_ccc.jpg"],
            "/library"
        );

        expect(resolved.get("thumbnails/thumb_aaa.jpg")).toBe("/cache/thumb-display/aaa.jpg");
        expect(resolved.get("thumbnails/thumb_ccc.jpg")).toBe("/cache/thumb-display/ccc.jpg");
        // A null answer is the ordinary "no derivative" case, so the path is simply absent and the
        // caller keeps rendering the stored file.
        expect(resolved.has("thumbnails/thumb_bbb.jpg")).toBe(false);
    });

    it("asks about each path once even when several media share a thumbnail", async () => {
        // Thumbnails are content-addressed, so two rows pointing at identical content share one
        // file - and the backend's per-call generation budget must not be spent twice on it.
        vi.mocked(invokeCommand).mockResolvedValueOnce(["/cache/thumb-display/aaa.jpg"]);

        const resolved = await resolveDisplayThumbnails(
            ["thumbnails/thumb_aaa.jpg", "thumbnails/thumb_aaa.jpg"],
            "/library"
        );

        expect(invokeCommand).toHaveBeenCalledWith(TAURI_COMMANDS.RESOLVE_DISPLAY_THUMBNAILS, {
            relativePaths: ["thumbnails/thumb_aaa.jpg"],
            libraryPath: "/library",
        });
        expect(resolved.get("thumbnails/thumb_aaa.jpg")).toBe("/cache/thumb-display/aaa.jpg");
    });

    it("drops blank and missing thumbnail paths before calling the backend", async () => {
        // A media with no thumbnail at all is normal (the card shows a placeholder), so those must
        // not travel as empty strings the backend would have to reject one by one.
        vi.mocked(invokeCommand).mockResolvedValueOnce(["/cache/thumb-display/aaa.jpg"]);

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
        expect((await resolveDisplayThumbnails([], "/library")).size).toBe(0);
        expect((await resolveDisplayThumbnails([null, "  "], "/library")).size).toBe(0);
        expect((await resolveDisplayThumbnails(["thumbnails/a.jpg"], "  ")).size).toBe(0);

        expect(invokeCommand).not.toHaveBeenCalled();
    });

    it("ignores an answer shorter than the request instead of misaligning it", async () => {
        // Defense in depth over the zod array schema at the seam: a truncated response must leave
        // the unanswered paths without a derivative, never shift the remaining answers onto them.
        vi.mocked(invokeCommand).mockResolvedValueOnce(["/cache/thumb-display/aaa.jpg"]);

        const resolved = await resolveDisplayThumbnails(
            ["thumbnails/thumb_aaa.jpg", "thumbnails/thumb_bbb.jpg"],
            "/library"
        );

        expect(resolved.get("thumbnails/thumb_aaa.jpg")).toBe("/cache/thumb-display/aaa.jpg");
        expect(resolved.has("thumbnails/thumb_bbb.jpg")).toBe(false);
    });
});
