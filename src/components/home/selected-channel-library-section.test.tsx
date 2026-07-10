import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedChannelLibrarySection } from "./selected-channel-library-section";
import { renderWithMantine } from "../../test/test-utils";
import type { MediaRow } from "../../types/media";

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

describe("SelectedChannelLibrarySection", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("renders channel header", () => {
        renderWithMantine(
            <SelectedChannelLibrarySection
                selectedChannel={{
                    id: 10,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                }}
                itemCountLabel="3 item(s)"
                disableAddMedia={false}
                isLoadingMedia={false}
                mediaItems={[createMediaRow()]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                onAddMedia={vi.fn()}
                onBack={vi.fn()}
                onOpenMedia={vi.fn()}
                onRequestDeleteMedia={vi.fn()}
            />
        );

        expect(screen.getByText("Canal A")).toBeInTheDocument();
        expect(screen.getByText((content) => content.includes("@canala"))).toBeInTheDocument();
        expect(screen.getByText("grid:1")).toBeInTheDocument();
    });

    it("calls add and back actions", () => {
        const onAddMedia = vi.fn();
        const onBack = vi.fn();

        renderWithMantine(
            <SelectedChannelLibrarySection
                selectedChannel={{
                    id: 10,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                }}
                itemCountLabel="0 item(s)"
                disableAddMedia={false}
                isLoadingMedia={false}
                mediaItems={[]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                onAddMedia={onAddMedia}
                onBack={onBack}
                onOpenMedia={vi.fn()}
                onRequestDeleteMedia={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: /add media/i }));
        fireEvent.click(screen.getByRole("button", { name: /back/i }));

        expect(onAddMedia).toHaveBeenCalledTimes(1);
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("filters media by publication date availability", () => {
        renderWithMantine(
            <SelectedChannelLibrarySection
                selectedChannel={{
                    id: 10,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                }}
                itemCountLabel="2 item(s)"
                disableAddMedia={false}
                isLoadingMedia={false}
                mediaItems={[
                    createMediaRow({
                        id: 1,
                        title: "With date",
                        file_path: "video/with-date.mp4",
                        published_at: "2026-03-31T10:00:00.000Z",
                    }),
                    createMediaRow({
                        id: 2,
                        title: "Without date",
                        file_path: "video/without-date.mp4",
                        published_at: null,
                    }),
                ]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                onAddMedia={vi.fn()}
                onBack={vi.fn()}
                onOpenMedia={vi.fn()}
                onRequestDeleteMedia={vi.fn()}
            />
        );

        expect(screen.getByText("grid:2")).toBeInTheDocument();
        expect(screen.getByTestId("grid-titles")).toHaveTextContent("With date");
        expect(screen.getByTestId("grid-titles")).toHaveTextContent("Without date");

        fireEvent.click(screen.getByRole("combobox", { name: /^publication date$/i }));
        fireEvent.click(screen.getByRole("option", { name: /with publication date/i }));

        expect(screen.getByText("grid:1")).toBeInTheDocument();
        expect(screen.getByTestId("grid-titles")).toHaveTextContent("With date");

        fireEvent.click(screen.getByRole("combobox", { name: /^publication date$/i }));
        fireEvent.click(screen.getByRole("option", { name: /no publication date/i }));

        expect(screen.getByText("grid:1")).toBeInTheDocument();
        expect(screen.getByTestId("grid-titles")).toHaveTextContent("Without date");
    });

    it("sorts by publication date without falling back to added date", () => {
        renderWithMantine(
            <SelectedChannelLibrarySection
                selectedChannel={{
                    id: 10,
                    name: "Canal A",
                    youtube_handle: "@canala",
                    avatar_path: null,
                    created_at: "2026-03-31T10:00:00.000Z",
                }}
                itemCountLabel="3 item(s)"
                disableAddMedia={false}
                isLoadingMedia={false}
                mediaItems={[
                    createMediaRow({
                        id: 1,
                        title: "No publication but recently added",
                        file_path: "video/no-publication.mp4",
                        published_at: null,
                        created_at: "2026-06-01T10:00:00.000Z",
                    }),
                    createMediaRow({
                        id: 2,
                        title: "New publication",
                        file_path: "video/new-publication.mp4",
                        published_at: "2025-01-01T10:00:00.000Z",
                        created_at: "2024-01-01T10:00:00.000Z",
                    }),
                    createMediaRow({
                        id: 3,
                        title: "Old publication",
                        file_path: "video/old-publication.mp4",
                        published_at: "2024-01-01T10:00:00.000Z",
                        created_at: "2026-07-01T10:00:00.000Z",
                    }),
                ]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                onAddMedia={vi.fn()}
                onBack={vi.fn()}
                onOpenMedia={vi.fn()}
                onRequestDeleteMedia={vi.fn()}
            />
        );

        expect(screen.getByTestId("grid-titles")).toHaveTextContent(
            "New publication,Old publication,No publication but recently added"
        );

        fireEvent.click(screen.getByRole("button", { name: /sort descending/i }));

        expect(screen.getByTestId("grid-titles")).toHaveTextContent(
            "Old publication,New publication,No publication but recently added"
        );
    });

    it("resets search/filters when the channel changes (remounts via key)", () => {
        const channelA = {
            id: 10,
            name: "Canal A",
            youtube_handle: "@canala",
            avatar_path: null,
            created_at: "2026-03-31T10:00:00.000Z",
        };
        const channelB = { ...channelA, id: 20, name: "Canal B", youtube_handle: "@canalb" };

        const baseProps = {
            itemCountLabel: "1 item(s)",
            disableAddMedia: false,
            isLoadingMedia: false,
            libraryPath: "/library",
            shellBorder: "rgba(255,255,255,0.1)",
            shellSurface: "rgba(255,255,255,0.03)",
            onAddMedia: vi.fn(),
            onBack: vi.fn(),
            onOpenMedia: vi.fn(),
            onRequestDeleteMedia: vi.fn(),
        };

        const { rerender } = renderWithMantine(
            <SelectedChannelLibrarySection
                key={channelA.id}
                selectedChannel={channelA}
                mediaItems={[
                    createMediaRow({ id: 1, title: "Alpha", file_path: "video/alpha.mp4" }),
                ]}
                {...baseProps}
            />
        );

        // Narrow channel A down to nothing with a search term that matches no title.
        act(() => {
            fireEvent.change(screen.getByRole("textbox"), {
                target: { value: "zzz-no-match" },
            });
        });

        act(() => {
            vi.advanceTimersByTime(200);
        });

        expect(screen.getByText("grid:0")).toBeInTheDocument();

        // Switching channels changes the key, so the section remounts with fresh state
        // instead of carrying channel A's search over to channel B.
        rerender(
            <SelectedChannelLibrarySection
                key={channelB.id}
                selectedChannel={channelB}
                mediaItems={[
                    createMediaRow({ id: 2, title: "Beta", file_path: "video/beta.mp4" }),
                ]}
                {...baseProps}
            />
        );

        expect(screen.getByRole("textbox")).toHaveValue("");
        expect(screen.getByText("grid:1")).toBeInTheDocument();
        expect(screen.getByTestId("grid-titles")).toHaveTextContent("Beta");
    });
});
