import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});