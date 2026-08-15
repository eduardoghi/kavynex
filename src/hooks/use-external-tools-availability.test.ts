import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    missingToolsForMode,
    useExternalToolsAvailability,
} from "./use-external-tools-availability";
import { getExternalToolsStatus } from "../services/diagnostics-external-tools";
import type { ExternalToolsStatus } from "../types/diagnostics";
import type { MediaSourceMode } from "../types/media";

vi.mock("../services/diagnostics-external-tools", () => ({
    getExternalToolsStatus: vi.fn(),
}));

function toolsStatus(ytDlpHealthy: boolean, ffmpegHealthy: boolean): ExternalToolsStatus {
    return {
        yt_dlp: {
            path: "yt-dlp",
            version: "2026.08.01",
            healthy: ytDlpHealthy,
            release_age_days: 3,
        },
        ffmpeg: {
            path: "ffmpeg",
            version: "7.1",
            healthy: ffmpegHealthy,
            release_age_days: null,
        },
    };
}

describe("missingToolsForMode", () => {
    it("reports nothing when both tools are healthy", () => {
        expect(missingToolsForMode(toolsStatus(true, true), "yt-dlp")).toEqual([]);
        expect(missingToolsForMode(toolsStatus(true, true), "local")).toEqual([]);
    });

    it("ignores yt-dlp for a local import, which never runs it", () => {
        expect(missingToolsForMode(toolsStatus(false, true), "local")).toEqual([]);
        expect(missingToolsForMode(toolsStatus(false, true), "yt-dlp")).toEqual(["yt-dlp"]);
    });

    it("reports ffmpeg in both modes, since a local import needs it for the thumbnail", () => {
        expect(missingToolsForMode(toolsStatus(true, false), "local")).toEqual(["ffmpeg"]);
        expect(missingToolsForMode(toolsStatus(true, false), "yt-dlp")).toEqual(["ffmpeg"]);
    });

    it("reports both when neither is available for a URL import", () => {
        expect(missingToolsForMode(toolsStatus(false, false), "yt-dlp")).toEqual([
            "yt-dlp",
            "ffmpeg",
        ]);
    });
});

describe("useExternalToolsAvailability", () => {
    it("does not check anything while the modal is closed", () => {
        renderHook(() => useExternalToolsAvailability(false, "yt-dlp"));

        expect(vi.mocked(getExternalToolsStatus)).not.toHaveBeenCalled();
    });

    it("reports the missing tool once the check resolves", async () => {
        vi.mocked(getExternalToolsStatus).mockResolvedValueOnce(toolsStatus(false, true));

        const { result } = renderHook(() => useExternalToolsAvailability(true, "yt-dlp"));

        // Nothing is claimed before the answer arrives: an import form that flashed "yt-dlp was
        // not found" on every open would be worse than saying nothing.
        expect(result.current.missingTools).toEqual([]);

        await waitFor(() => {
            expect(result.current.missingTools).toEqual(["yt-dlp"]);
        });
    });

    it("switches which tools matter without probing again", async () => {
        vi.mocked(getExternalToolsStatus).mockResolvedValueOnce(toolsStatus(false, true));

        const { result, rerender } = renderHook(
            ({ mode }: { mode: MediaSourceMode }) => useExternalToolsAvailability(true, mode),
            { initialProps: { mode: "yt-dlp" satisfies MediaSourceMode as MediaSourceMode } }
        );

        await waitFor(() => {
            expect(result.current.missingTools).toEqual(["yt-dlp"]);
        });

        rerender({ mode: "local" });

        expect(result.current.missingTools).toEqual([]);
        expect(vi.mocked(getExternalToolsStatus)).toHaveBeenCalledTimes(1);
    });

    it("forgets the previous answer when the modal closes, so a reopen re-checks", async () => {
        vi.mocked(getExternalToolsStatus).mockResolvedValue(toolsStatus(false, true));

        const { result, rerender } = renderHook(
            ({ open }: { open: boolean }) => useExternalToolsAvailability(open, "yt-dlp"),
            { initialProps: { open: true } }
        );

        await waitFor(() => {
            expect(result.current.missingTools).toEqual(["yt-dlp"]);
        });

        rerender({ open: false });
        expect(result.current.missingTools).toEqual([]);

        // The usual reason to close this modal after seeing the warning is to go install the tool,
        // so the reopen must ask again rather than show what was true before.
        rerender({ open: true });
        await waitFor(() => {
            expect(vi.mocked(getExternalToolsStatus)).toHaveBeenCalledTimes(2);
        });
    });

    it("stays silent when the check itself fails", async () => {
        vi.mocked(getExternalToolsStatus).mockRejectedValueOnce(new Error("probe failed"));

        const { result } = renderHook(() => useExternalToolsAvailability(true, "yt-dlp"));

        await waitFor(() => {
            expect(vi.mocked(getExternalToolsStatus)).toHaveBeenCalled();
        });

        // A failure to probe is not evidence that a tool is missing, and warning about it in the
        // import form would be alarming about the wrong thing.
        expect(result.current.missingTools).toEqual([]);
    });
});
