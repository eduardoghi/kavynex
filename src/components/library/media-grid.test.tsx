import { useState } from "react";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MediaGrid } from "./media-grid";
import { createMedia } from "../../test/factories/media";
import { renderWithMantine } from "../../test/test-utils";

const { scrollToIndexMock } = vi.hoisted(() => ({ scrollToIndexMock: vi.fn() }));

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: vi.fn(({ count }: { count: number }) => ({
        getTotalSize: () => count * 308,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 308,
            })),
        measureElement: vi.fn(),
        measure: vi.fn(),
        scrollToIndex: scrollToIndexMock,
    })),
}));

vi.mock("./media-card", () => ({
    MEDIA_CARD_HEIGHT: 292,
    MediaCard: ({
        media,
        onOpen,
        onRequestDelete,
    }: {
        media: { title: string };
        onOpen: (media: unknown) => void;
        onRequestDelete: (media: unknown) => void;
    }) => (
        <div>
            <span>{media.title}</span>
            <button onClick={() => onOpen(media)}>open</button>
            <button onClick={() => onRequestDelete(media)}>delete</button>
        </div>
    ),
}));

describe("MediaGrid", () => {
    it("shows loading state", () => {
        renderWithMantine(
            <MediaGrid
                items={[]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("Loading media...")).toBeInTheDocument();
        // The shared LoadingStateCard exposes role="status" so a screen reader announces the
        // load, matching the comments/live-chat panels.
        expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("shows empty state", () => {
        renderWithMantine(
            <MediaGrid
                items={[]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("No media yet")).toBeInTheDocument();
    });

    it("renders media items", () => {
        renderWithMantine(
            <MediaGrid
                items={[
                    createMedia({ id: 1, title: "Video A" }),
                    createMedia({ id: 2, title: "Audio B", media_type: "audio" }),
                ]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("Video A")).toBeInTheDocument();
        expect(screen.getByText("Audio B")).toBeInTheDocument();
    });

    it("scrolls to a focused media once and clears the request", () => {
        scrollToIndexMock.mockClear();

        // Mirror the real caller (Home): clearing focus on onFocusHandled is what stops the
        // effect from acting again. Without it the mocked virtualizer's fresh-per-render identity
        // would make the effect re-run.
        function Harness(): JSX.Element {
            const [focus, setFocus] = useState<number | null>(2);

            return (
                <MediaGrid
                    items={[
                        createMedia({ id: 1, title: "First" }),
                        createMedia({ id: 2, title: "Second" }),
                    ]}
                    libraryPath="/library"
                    shellBorder="rgba(255,255,255,0.1)"
                    shellSurface="rgba(255,255,255,0.03)"
                    loading={false}
                    focusMediaId={focus}
                    onFocusHandled={() => setFocus(null)}
                    onOpen={vi.fn()}
                    onRequestDelete={vi.fn()}
                />
            );
        }

        renderWithMantine(<Harness />);

        // jsdom reports width 0, so the grid is a single column: the second item is row index 1.
        expect(scrollToIndexMock).toHaveBeenCalledTimes(1);
        expect(scrollToIndexMock).toHaveBeenCalledWith(1, { align: "center" });
    });

    it("does not scroll when the focused media is not in the list", () => {
        const onFocusHandled = vi.fn();
        scrollToIndexMock.mockClear();

        renderWithMantine(
            <MediaGrid
                items={[createMedia({ id: 1, title: "First" })]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                focusMediaId={999}
                onFocusHandled={onFocusHandled}
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        // The target has not loaded yet: no scroll and the request is kept (not cleared).
        expect(scrollToIndexMock).not.toHaveBeenCalled();
        expect(onFocusHandled).not.toHaveBeenCalled();
    });
});