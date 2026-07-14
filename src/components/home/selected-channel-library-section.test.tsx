import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedChannelLibrarySection } from "./selected-channel-library-section";
import { renderWithMantine } from "../../test/test-utils";
import type { MediaRow } from "../../types/media";
import type { Channel } from "../../types/media";

vi.mock("../../utils/media-utils", () => ({
    initials: vi.fn((value: string) => value.slice(0, 2).toUpperCase()),
    fileSrcFromStoredPath: vi.fn(() => ""),
}));

vi.mock("../library/media-grid", () => ({
    MediaGrid: ({
        onOpen,
        onRequestDelete,
        items,
    }: {
        onOpen: (media: unknown) => void;
        onRequestDelete: (media: unknown) => void;
        items: Array<{ id: number; title: string }>;
    }) => (
        <div>
            <span>grid:{items.length}</span>
            <span data-testid="grid-titles">{items.map((item) => item.title).join(",")}</span>
            <button onClick={() => onOpen(items[0])}>open media</button>
            <button onClick={() => onRequestDelete(items[0])}>delete media</button>
        </div>
    ),
}));

function createMediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
    return {
        id: 1,
        channel_id: 10,
        title: "Item 1",
        file_path: "video/item-1.mp4",
        thumbnail_path: null,
        media_type: "video",
        youtube_video_id: null,
        watched_at: null,
        published_at: null,
        duration_seconds: 0,
        progress_seconds: 0,
        has_comments: 0,
        comments_count: 0,
        is_live: 0,
        has_live_chat: 0,
        live_chat_file_path: null,
        created_at: "2026-03-31T10:00:00.000Z",
        ...overrides,
    };
}

const CHANNEL_A: Channel = {
    id: 10,
    name: "Canal A",
    youtube_handle: "@canala",
    avatar_path: null,
    created_at: "2026-03-31T10:00:00.000Z",
};

// Fresh props (with fresh spies) per render so onApplyQuery/onLoadMore assertions do not leak
// across tests.
function makeProps(
    overrides: Partial<React.ComponentProps<typeof SelectedChannelLibrarySection>> = {}
): React.ComponentProps<typeof SelectedChannelLibrarySection> {
    return {
        selectedChannel: CHANNEL_A,
        itemCountLabel: "1 item(s)",
        disableAddMedia: false,
        isLoadingMedia: false,
        mediaItems: [createMediaRow()],
        total: 1,
        channelTotal: 1,
        hasMore: false,
        isLoadingMore: false,
        onApplyQuery: vi.fn(),
        onLoadMore: vi.fn(),
        libraryPath: "/library",
        shellBorder: "rgba(255,255,255,0.1)",
        shellSurface: "rgba(255,255,255,0.03)",
        onAddMedia: vi.fn(),
        onBack: vi.fn(),
        onOpenMedia: vi.fn(),
        onRequestDeleteMedia: vi.fn(),
        ...overrides,
    };
}

describe("SelectedChannelLibrarySection", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("renders the channel header and the grid items it was given", () => {
        renderWithMantine(<SelectedChannelLibrarySection {...makeProps()} />);

        expect(screen.getByText("Canal A")).toBeInTheDocument();
        expect(screen.getByText((content) => content.includes("@canala"))).toBeInTheDocument();
        expect(screen.getByText("grid:1")).toBeInTheDocument();
    });

    it("requests the first page on mount with the default filters", () => {
        const onApplyQuery = vi.fn();

        renderWithMantine(
            <SelectedChannelLibrarySection {...makeProps({ onApplyQuery })} />
        );

        expect(onApplyQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                mediaType: "all",
                watched: "all",
                publication: "all",
                search: "",
                sortCategory: "publication_date",
                sortDirection: "desc",
            })
        );
    });

    it("calls add and back actions", () => {
        const onAddMedia = vi.fn();
        const onBack = vi.fn();

        renderWithMantine(
            <SelectedChannelLibrarySection
                {...makeProps({ onAddMedia, onBack, mediaItems: [], total: 0, channelTotal: 0 })}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /add media/i }));
        fireEvent.click(screen.getByRole("button", { name: /back/i }));

        expect(onAddMedia).toHaveBeenCalledTimes(1);
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("requests a publication-date filter from the backend when it changes", () => {
        const onApplyQuery = vi.fn();

        renderWithMantine(
            <SelectedChannelLibrarySection {...makeProps({ onApplyQuery })} />
        );

        fireEvent.click(screen.getByRole("combobox", { name: /^publication date$/i }));
        fireEvent.click(screen.getByRole("option", { name: /with publication date/i }));

        expect(onApplyQuery).toHaveBeenLastCalledWith(
            expect.objectContaining({ publication: "with" })
        );

        fireEvent.click(screen.getByRole("combobox", { name: /^publication date$/i }));
        fireEvent.click(screen.getByRole("option", { name: /no publication date/i }));

        expect(onApplyQuery).toHaveBeenLastCalledWith(
            expect.objectContaining({ publication: "without" })
        );
    });

    it("requests a sort direction change from the backend", () => {
        const onApplyQuery = vi.fn();

        renderWithMantine(
            <SelectedChannelLibrarySection {...makeProps({ onApplyQuery })} />
        );

        // The default direction is descending; toggling it asks the backend for ascending.
        fireEvent.click(screen.getByRole("button", { name: /sort descending/i }));

        expect(onApplyQuery).toHaveBeenLastCalledWith(
            expect.objectContaining({ sortDirection: "asc" })
        );
    });

    it("debounces the search term before querying and resets on channel remount", () => {
        const onApplyQuery = vi.fn();
        const props = makeProps({ onApplyQuery });

        const { rerender } = renderWithMantine(
            <SelectedChannelLibrarySection key={CHANNEL_A.id} {...props} />
        );

        act(() => {
            fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
        });

        // Before the debounce elapses the term has not been sent.
        expect(onApplyQuery).not.toHaveBeenCalledWith(
            expect.objectContaining({ search: "hello" })
        );

        act(() => {
            vi.advanceTimersByTime(200);
        });

        expect(onApplyQuery).toHaveBeenLastCalledWith(
            expect.objectContaining({ search: "hello" })
        );

        // Switching channels remounts the section (key change): the search input resets and the
        // fresh mount queries with the default empty search.
        const channelB: Channel = { ...CHANNEL_A, id: 20, name: "Canal B", youtube_handle: "@canalb" };
        const onApplyQueryB = vi.fn();

        rerender(
            <SelectedChannelLibrarySection
                key={channelB.id}
                {...makeProps({
                    onApplyQuery: onApplyQueryB,
                    selectedChannel: channelB,
                    mediaItems: [createMediaRow({ id: 2, title: "Beta" })],
                })}
            />
        );

        expect(screen.getByRole("textbox")).toHaveValue("");
        expect(onApplyQueryB).toHaveBeenLastCalledWith(
            expect.objectContaining({ search: "" })
        );
        expect(screen.getByTestId("grid-titles")).toHaveTextContent("Beta");
    });
});
