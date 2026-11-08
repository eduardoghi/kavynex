import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelMissingMediaModal } from "./channel-missing-media-modal";
import type { ChannelMissingMediaController } from "../../hooks/channels/use-channel-missing-media";
import type { MissingChannelMedia } from "../../types/generated/MissingChannelMedia";
import { renderWithMantine } from "../../test/test-utils";
import { idleBatchImport } from "../../test/factories/media-library";
import { createYtDlpTerminalStore } from "../../hooks/yt-dlp-terminal-store";
import { FORMATS_PAUSE_MS } from "../../hooks/use-batch-formats";
import type { YtDlpFormat } from "../../types/media";

// The batch setup lists each media's formats through this service.
vi.mock("../../services/media-download-service", () => ({
    listYtDlpFormats: vi.fn(),
    cancelMediaDownload: vi.fn().mockResolvedValue(undefined),
}));

import { listYtDlpFormats } from "../../services/media-download-service";

function format(overrides: Partial<YtDlpFormat>): YtDlpFormat {
    return {
        format_id: "0",
        ext: "mp4",
        media_type: "video",
        has_video: true,
        has_audio: true,
        filesize_bytes: null,
        height: null,
        abr: null,
        tbr: null,
        vcodec: null,
        protocol: null,
        ...overrides,
    };
}

const LISTING: MissingChannelMedia = {
    missing: [
        {
            youtube_video_id: "aaaaaaaaaaa",
            title: "A video",
            kind: "video",
            duration_seconds: 61,
            published_at: 1_700_000_000,
        },
        {
            youtube_video_id: "bbbbbbbbbbb",
            title: "A live",
            kind: "live",
            duration_seconds: 7200,
            published_at: null,
        },
    ],
    ignored: [
        {
            youtube_video_id: "ddddddddddd",
            title: "An ignored one",
            kind: "video",
            duration_seconds: 30,
            published_at: null,
        },
    ],
    listed: 6,
};

function controller(
    overrides: Partial<ChannelMissingMediaController> = {}
): ChannelMissingMediaController {
    return {
        result: null,
        isLoading: false,
        error: null,
        openedIds: new Set(),
        ignoreError: null,
        check: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn(),
        markOpened: vi.fn(),
        setIgnored: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function renderModal(
    missingMedia: ChannelMissingMediaController,
    props: Partial<React.ComponentProps<typeof ChannelMissingMediaModal>> = {}
) {
    const onImport = vi.fn();
    const onClose = vi.fn();

    renderWithMantine(
        <ChannelMissingMediaModal
            opened
            onClose={onClose}
            channelId={10}
            channelName="Canal A"
            missingMedia={missingMedia}
            onImport={onImport}
            importDisabledReason={null}
            batchImport={idleBatchImport()}
            terminal={createYtDlpTerminalStore()}
            isYtDlpRunning={false}
            {...props}
        />
    );

    return { onImport, onClose };
}

describe("ChannelMissingMediaModal", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("lists the channel the first time it opens", () => {
        const missingMedia = controller();

        renderModal(missingMedia);

        expect(missingMedia.check).toHaveBeenCalledTimes(1);
    });

    it("says how many are missing and offers each one to import", () => {
        const { onImport } = renderModal(controller({ result: LISTING }));

        expect(screen.getByText("3 of 6 are not in the library.")).toBeInTheDocument();
        expect(screen.queryByText("An ignored one")).not.toBeInTheDocument();
        expect(screen.getByText("A video")).toBeInTheDocument();
        expect(screen.getByText("Live · 2:00:00")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Import A video" }));

        expect(onImport).toHaveBeenCalledWith(LISTING.missing[0]);
    });

    it("filters the list to the videos or the lives", () => {
        renderModal(controller({ result: LISTING }));

        fireEvent.click(screen.getByText("Lives (1)"));

        expect(screen.queryByText("A video")).not.toBeInTheDocument();
        expect(screen.getByText("A live")).toBeInTheDocument();
    });

    it("searches the titles without regard to case or accents", () => {
        const accented: MissingChannelMedia = {
            ...LISTING,
            missing: [
                ...LISTING.missing,
                {
                    ...LISTING.missing[0]!,
                    youtube_video_id: "ccccccccccc",
                    title: "Ação ao vivo",
                },
            ],
        };
        renderModal(controller({ result: accented }));
        const searchBox = screen.getByRole("textbox", {
            name: "Search the titles not in the library",
        });

        fireEvent.change(searchBox, { target: { value: "acao" } });

        expect(screen.getByText("Ação ao vivo")).toBeInTheDocument();
        expect(screen.queryByText("A video")).not.toBeInTheDocument();
        expect(screen.getByText("All (1)")).toBeInTheDocument();

        fireEvent.change(searchBox, { target: { value: "nothing like it" } });

        expect(screen.getByText("Nothing here matches the search.")).toBeInTheDocument();
    });

    it("says so when the library has everything the channel lists", () => {
        renderModal(controller({ result: { missing: [], ignored: [], listed: 5 } }));

        expect(
            screen.getByText("All 5 videos and lives the channel lists are in the library.")
        ).toBeInTheDocument();
    });

    it("ignores a media, and shows an ignored one again from its own tab", () => {
        const missingMedia = controller({ result: LISTING });
        renderModal(missingMedia);

        fireEvent.click(screen.getByRole("button", { name: "Ignore A video" }));
        expect(missingMedia.setIgnored).toHaveBeenCalledWith(LISTING.missing[0], true);

        fireEvent.click(screen.getByText("Ignored (1)"));

        expect(screen.getByText("An ignored one")).toBeInTheDocument();
        expect(screen.queryByText("A video")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Import An ignored one" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Show An ignored one again" }));
        expect(missingMedia.setIgnored).toHaveBeenCalledWith(LISTING.ignored[0], false);
    });

    it("says when a move could not be saved", () => {
        renderModal(
            controller({ result: LISTING, ignoreError: "The media could not be ignored." })
        );

        expect(screen.getByText("The media could not be ignored.")).toBeInTheDocument();
    });

    it("lists each picked media's formats and starts the batch in the ones chosen", async () => {
        vi.useFakeTimers();
        vi.mocked(listYtDlpFormats).mockImplementation(async (url: string) => ({
            suggested_title: `Title ${url.slice(-11)}`,
            youtube_video_id: url.slice(-11),
            formats: [
                format({ format_id: "137", has_audio: false, height: 1080 }),
                format({ format_id: "136", has_audio: false, height: 720 }),
                format({ format_id: "140", has_video: false, media_type: "audio", abr: 128 }),
            ],
            terminal_logs: [],
        }));
        const batchImport = { ...idleBatchImport(), start: vi.fn().mockResolvedValue(undefined) };
        renderModal(controller({ result: LISTING }), { batchImport });

        fireEvent.click(screen.getByRole("checkbox", { name: "Select A live" }));
        fireEvent.click(screen.getByRole("checkbox", { name: "Select A video" }));
        fireEvent.click(screen.getByRole("button", { name: "Import selected (2)" }));
        fireEvent.click(screen.getByRole("checkbox", { name: "Save the live chat" }));
        fireEvent.click(screen.getByRole("button", { name: "Load formats" }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(FORMATS_PAUSE_MS);
        });

        // One select per media, each on what the form would pre-select.
        expect(screen.getAllByLabelText("Format for Title aaaaaaaaaaa").length).toBeGreaterThan(0);
        expect(screen.getAllByLabelText("Format for Title bbbbbbbbbbb").length).toBeGreaterThan(0);

        fireEvent.click(screen.getByRole("button", { name: "Start (2)" }));

        // In the list's order, whatever order they were picked in, under yt-dlp's titles.
        expect(batchImport.start).toHaveBeenCalledWith(
            10,
            [
                {
                    youtubeVideoId: "aaaaaaaaaaa",
                    title: "Title aaaaaaaaaaa",
                    formatId: "137+140",
                },
                {
                    youtubeVideoId: "bbbbbbbbbbb",
                    title: "Title bbbbbbbbbbb",
                    formatId: "137+140",
                },
            ],
            {
                downloadComments: true,
                downloadLiveChat: false,
                cookiesBrowser: null,
                cookiesPath: null,
            }
        );
    });

    it("leaves out a media whose formats could not be loaded", async () => {
        vi.mocked(listYtDlpFormats).mockRejectedValueOnce(new Error("HTTP Error 429"));
        renderModal(controller({ result: LISTING }));

        fireEvent.click(screen.getByRole("checkbox", { name: "Select A video" }));
        fireEvent.click(screen.getByRole("button", { name: "Import selected (1)" }));
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Load formats" }));
        });

        expect(
            screen.getByRole("button", { name: "Load the formats of A video again" })
        ).toBeInTheDocument();
        expect(screen.getByText("1 without formats will be left out.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Start (0)" })).toBeDisabled();
    });

    it("selects every media the filters show", () => {
        renderModal(controller({ result: LISTING }));

        fireEvent.click(screen.getByText("Lives (1)"));
        fireEvent.click(screen.getByRole("checkbox", { name: "Select all shown (1)" }));

        expect(screen.getByRole("button", { name: "Import selected (1)" })).toBeEnabled();
    });

    it("shows the batch in progress for this channel instead of the list", () => {
        const batchImport = {
            ...idleBatchImport(),
            channelId: 10,
            isRunning: true,
            items: [
                {
                    youtubeVideoId: "aaaaaaaaaaa",
                    title: "A video",
                    formatId: "18",
                    status: "downloading" as const,
                    message: null,
                },
                {
                    youtubeVideoId: "bbbbbbbbbbb",
                    title: "A live",
                    formatId: "18",
                    status: "waiting" as const,
                    message: null,
                },
            ],
        };
        renderModal(controller({ result: LISTING }), { batchImport });

        expect(screen.getByText("Importing 1 of 2")).toBeInTheDocument();
        expect(screen.getByText("Downloading")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Import A video" })).toBeNull();
    });

    it("sums a finished batch up, offers the failed ones again and leaves the added out", () => {
        const retryFailed = vi.fn().mockResolvedValue(undefined);
        const clear = vi.fn();
        const batchImport = {
            ...idleBatchImport(),
            channelId: 10,
            retryFailed,
            clear,
            items: [
                {
                    youtubeVideoId: "aaaaaaaaaaa",
                    title: "A video",
                    formatId: "18",
                    status: "done" as const,
                    message: null,
                },
                {
                    youtubeVideoId: "bbbbbbbbbbb",
                    title: "A live",
                    formatId: "18",
                    status: "failed" as const,
                    message: "HTTP Error 403",
                },
            ],
        };
        renderModal(controller({ result: LISTING }), { batchImport });

        expect(screen.getByText("1 added, 1 failed, 0 stopped")).toBeInTheDocument();
        expect(screen.getByText("HTTP Error 403")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Retry failed" }));
        expect(retryFailed).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Back to the list" }));
        expect(clear).toHaveBeenCalledTimes(1);
    });

    it("keeps a batch from starting while one runs for another channel", () => {
        const batchImport = { ...idleBatchImport(), channelId: 99, isRunning: true };
        renderModal(controller({ result: LISTING }), { batchImport });

        fireEvent.click(screen.getByRole("checkbox", { name: "Select A video" }));

        expect(
            screen.getByText("A batch import for another channel is running.")
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Import selected (1)" })).toBeDisabled();
    });

    it("keeps import off, and says why, while a media cannot be added", () => {
        renderModal(controller({ result: LISTING }), {
            importDisabledReason: "Choose a library folder first.",
        });

        expect(screen.getByText("Choose a library folder first.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Import A video" })).toBeDisabled();
    });

    it("stops a listing that is running when it closes", () => {
        const missingMedia = controller({ isLoading: true });
        const { onClose } = renderModal(missingMedia);

        fireEvent.click(
            screen.getByRole("button", { name: "Close the list of media not in the library" })
        );

        expect(missingMedia.cancel).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("offers to try again after a failure", () => {
        const missingMedia = controller({ error: "HTTP Error 429" });

        renderModal(missingMedia);
        vi.mocked(missingMedia.check).mockClear();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(missingMedia.check).toHaveBeenCalledTimes(1);
    });
});
