// The add, cancel and delete flows with every hook real and only Tauri's `invoke`/`listen` faked.
//
// The unit tests of these hooks mock their neighbours (the form, the yt-dlp event stream, the list),
// so each proves its own wiring and none proves the flow. A cancel that the workflow sends with the
// wrong run id, or a list that does not drop a deleted row, passes every one of them. Here the fake
// sits under `src/lib/tauri-client.ts`, so the IPC result schemas run too, and the assertions are
// about what the user ends up seeing.
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMedia as createMediaRow } from "../../test/factories/media";
import type { MediaRow } from "../../types/media";
import { DEFAULT_MEDIA_QUERY_FILTERS } from "../../utils/media-library-filters";

type Handler = (args: Record<string, unknown>) => unknown;

const backend = vi.hoisted(() => ({
    handlers: new Map<string, Handler>(),
    calls: [] as { command: string; args: Record<string, unknown> }[],
    listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
        backend.calls.push({ command, args });
        const handler = backend.handlers.get(command);
        return handler ? handler(args) : undefined;
    }),
    Channel: class {
        onmessage: ((message: unknown) => void) | null = null;
    },
    convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
        backend.listeners.set(event, handler);
        return () => backend.listeners.delete(event);
    }),
}));

import { useMediaLibrary } from "./use-media-library";

function on(command: string, handler: Handler): void {
    backend.handlers.set(command, handler);
}

function callsOf(command: string): Record<string, unknown>[] {
    return backend.calls.filter((call) => call.command === command).map((call) => call.args);
}

// A command that stays pending until `cancel_media_download` names the run it was started with,
// then fails the way the backend unwinds a cancel.
function pendingUntilCancelled(runIdOf: (args: Record<string, unknown>) => unknown, code: string) {
    let started: Record<string, unknown> | null = null;
    let reject: ((reason: unknown) => void) | null = null;

    on("create_media", (args) => {
        started = args;
        return new Promise((_, fail) => {
            reject = fail;
        });
    });

    on("cancel_media_download", (args) => {
        if (started === null || args.runId !== runIdOf(started)) {
            throw { code: "INVALID_RUN_ID", message: "unknown run" };
        }

        reject?.({ code, message: "cancelled" });
    });

    return {
        isStarted: () => started !== null,
    };
}

function renderLibrary() {
    const onError = vi.fn();
    const onNotice = vi.fn();

    const hook = renderHook(() =>
        useMediaLibrary({
            libraryPath: "/library",
            importMode: "copy",
            onError,
            onNotice,
            selectedChannelId: 10,
        })
    );

    return { ...hook, onError, onNotice };
}

function page(items: MediaRow[], total = items.length) {
    return { items, total };
}

describe("media library flows over a faked IPC", () => {
    beforeEach(() => {
        backend.handlers.clear();
        backend.calls.length = 0;
        backend.listeners.clear();
    });

    it("cancels a local import, says nothing was added and does not reload the list", async () => {
        on("list_media_page", () => page([]));
        on("open_file_dialog", () => "/videos/clip.mp4");
        on("generate_temporary_thumbnail", () => "/cache/thumbs/clip.jpg");
        const run = pendingUntilCancelled(
            (args) => (args.request as { ytDlpRunId: string }).ytDlpRunId,
            "MEDIA_IMPORT_CANCELLED"
        );

        const { result, onError, onNotice } = renderLibrary();

        await act(async () => {
            await result.current.applyMediaQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });
        const listLoads = callsOf("list_media_page").length;

        await act(async () => {
            await result.current.addMediaForm.setSourceMode("local");
        });
        await act(async () => {
            await result.current.addMediaForm.pickMediaViaDialog();
        });
        expect(result.current.addMediaForm.mediaPath).toBe("/videos/clip.mp4");

        let adding: Promise<void> = Promise.resolve();
        act(() => {
            adding = result.current.addMedia();
        });

        await waitFor(() => expect(run.isStarted()).toBe(true));
        expect(result.current.isAddingMedia).toBe(true);

        await act(async () => {
            await result.current.cancelYtDlpDownload();
            await adding;
        });

        expect(onNotice).toHaveBeenCalledWith(
            "Import cancelled. Nothing was added to your library and the original file was left where it was."
        );
        expect(onError).not.toHaveBeenCalled();
        expect(result.current.isAddingMedia).toBe(false);
        expect(callsOf("list_media_page")).toHaveLength(listLoads);
    });

    it("cancels a download through the run it started and reports it as a notice", async () => {
        on("list_media_page", () => page([]));
        on("list_yt_dlp_formats", () => ({
            suggested_title: "A video",
            youtube_video_id: "dQw4w9WgXcQ",
            formats: [
                {
                    format_id: "18",
                    ext: "mp4",
                    media_type: "video",
                    has_video: true,
                    has_audio: true,
                    filesize_bytes: null,
                    height: 360,
                    abr: null,
                    tbr: null,
                    vcodec: "avc1",
                    protocol: "https",
                },
            ],
            terminal_logs: [],
        }));
        const run = pendingUntilCancelled(
            (args) => (args.request as { ytDlpRunId: string }).ytDlpRunId,
            "YT_DLP_DOWNLOAD_CANCELLED"
        );

        const { result, onError, onNotice } = renderLibrary();

        await act(async () => {
            await result.current.addMediaForm.setSourceMode("yt-dlp");
        });
        act(() => {
            result.current.addMediaForm.setMediaUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        });
        await act(async () => {
            await result.current.addMediaForm.loadYtDlpFormats();
        });
        act(() => {
            result.current.addMediaForm.setSelectedYtDlpFormatId("18");
        });

        let adding: Promise<void> = Promise.resolve();
        act(() => {
            adding = result.current.addMedia();
        });

        await waitFor(() => expect(run.isStarted()).toBe(true));
        expect(result.current.isYtDlpRunning).toBe(true);

        await act(async () => {
            await result.current.cancelYtDlpDownload();
            await adding;
        });

        expect(onNotice).toHaveBeenCalledWith(
            "Download cancelled. Nothing was added to your library."
        );
        expect(onError).not.toHaveBeenCalled();
        expect(result.current.isYtDlpRunning).toBe(false);
        expect(result.current.isAddingMedia).toBe(false);
    });

    it("deletes a media and drops it from the list and the counts", async () => {
        const first = createMediaRow({ id: 1, title: "First" });
        const second = createMediaRow({ id: 2, title: "Second", file_path: "media/item-2.mp4" });
        on("list_media_page", () => page([first, second]));
        on("delete_media_with_artifacts", () => ({
            deleted_paths: ["media/item-1.mp4"],
            skipped_shared_paths: [],
            failed_paths: [],
        }));

        const { result, onError } = renderLibrary();

        await act(async () => {
            await result.current.applyMediaQuery(DEFAULT_MEDIA_QUERY_FILTERS);
        });
        expect(result.current.mediaTotal).toBe(2);

        act(() => {
            result.current.requestDeleteMedia(first);
        });
        expect(result.current.confirmDeleteMediaOpen).toBe(true);

        await act(async () => {
            await result.current.confirmDeleteMedia();
        });

        expect(callsOf("delete_media_with_artifacts")).toEqual([{ mediaId: 1 }]);
        expect(result.current.mediaItems.map((item) => item.id)).toEqual([2]);
        expect(result.current.mediaTotal).toBe(1);
        expect(result.current.channelMediaTotal).toBe(1);
        expect(result.current.confirmDeleteMediaOpen).toBe(false);
        expect(onError).not.toHaveBeenCalled();
    });
});
