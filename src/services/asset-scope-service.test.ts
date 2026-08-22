import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

import { invokeVoid } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { registerLibraryAssetScope } from "./asset-scope-service";

// This is the call that widens the asset-protocol scope (the app's local-file-read boundary for
// the webview) to the library. What it sends, and when it sends nothing, is the whole of its
// behavior, so both are pinned rather than left to the backend's guard alone.
describe("registerLibraryAssetScope", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("sends the trimmed library path to the register command", async () => {
        vi.mocked(invokeVoid).mockResolvedValueOnce(undefined);

        await registerLibraryAssetScope("  /home/me/Kavynex Library  ");

        expect(invokeVoid).toHaveBeenCalledTimes(1);
        expect(invokeVoid).toHaveBeenCalledWith(TAURI_COMMANDS.REGISTER_LIBRARY_ASSET_SCOPE, {
            libraryPath: "/home/me/Kavynex Library",
        });
    });

    it("does not call the backend for a blank path", async () => {
        // Before a library is configured there is nothing to authorize. A blank request would
        // reach the backend's guard and come back as an error the bootstrap would have to swallow.
        await registerLibraryAssetScope("");
        await registerLibraryAssetScope("   ");

        expect(invokeVoid).not.toHaveBeenCalled();
    });

    it("lets the backend's refusal through unchanged", async () => {
        // The guard against a path that is not the configured library lives in Rust and answers
        // with a structured error. Nothing here may turn that into a success or a different error.
        const refusal = new Error("requested path does not match the configured library directory");
        vi.mocked(invokeVoid).mockRejectedValueOnce(refusal);

        await expect(registerLibraryAssetScope("/elsewhere")).rejects.toBe(refusal);
    });
});
