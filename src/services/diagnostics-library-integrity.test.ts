import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
}));

import { invokeCommand } from "../lib/tauri-client";
import { getLibraryIntegrity } from "./diagnostics-library-integrity";
import { TAURI_COMMANDS } from "../constants/tauri-commands";

const invokeCommandMock = vi.mocked(invokeCommand);

/// The command's answer, with only the fields a test cares about set. The real report carries
/// every counter. The service passes it straight through, so the shape it forwards is what
/// matters here rather than the values.
function checkResult(overrides: Record<string, unknown> = {}) {
    return {
        report: { checked_media_files: 3, missing_media_files: 1 },
        mediaTargets: {},
        ...overrides,
    } as never;
}

describe("getLibraryIntegrity", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        invokeCommandMock.mockResolvedValue(checkResult());
    });

    it("asks the backend for the whole check with no arguments at all", async () => {
        // The renderer no longer reads every media row to build three arrays of stored paths and
        // send them back, and the backend reads the library from the settings. A payload carrying
        // anything again would mean one of those came back.
        await getLibraryIntegrity("/library");

        expect(invokeCommandMock).toHaveBeenCalledTimes(1);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.CHECK_LIBRARY_INTEGRITY);
    });

    it("passes the report through and exposes the targets as the lookup the rules expect", async () => {
        // `mediaByPath` is what diagnostics-rules indexes with a reported example path, so the
        // rename from the command's own `mediaTargets` has to happen here and nowhere else.
        invokeCommandMock.mockResolvedValueOnce(
            checkResult({
                mediaTargets: {
                    "video/gone.mp4": { channelId: 10, mediaId: 2 },
                },
            })
        );

        const result = await getLibraryIntegrity("/library");

        expect(result.report.checked_media_files).toBe(3);
        expect(result.mediaByPath["video/gone.mp4"]).toEqual({ channelId: 10, mediaId: 2 });
    });

    it("skips the backend call entirely when the library path is blank", async () => {
        // There is no library to walk and no path to verify against the persisted setting, so the
        // round trip would only come back as a refusal.
        const result = await getLibraryIntegrity("   ");

        expect(result.report.checked_media_files).toBe(0);
        expect(result.mediaByPath).toEqual({});
        expect(invokeCommandMock).not.toHaveBeenCalled();
    });

    it("still calls through when the database has nothing to check", async () => {
        // An empty target map is not a reason to skip. The library folder can hold orphan files
        // no row references, and that half of the report is the one the rows cannot answer.
        invokeCommandMock.mockResolvedValueOnce(
            checkResult({
                report: { checked_media_files: 0, orphan_media_files: 4 },
                mediaTargets: {},
            })
        );

        const result = await getLibraryIntegrity("/library");

        expect(invokeCommandMock).toHaveBeenCalledTimes(1);
        expect(result.report.orphan_media_files).toBe(4);
    });
});
