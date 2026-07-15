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

    it("gives up (clears the focus) when the target is not in the list and no pages remain", () => {
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
                hasMore={false}
                onFocusHandled={onFocusHandled}
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        // The target is not in the current filtered set and there are no more pages to load, so
        // the grid does not scroll and clears the request instead of waiting forever.
        expect(scrollToIndexMock).not.toHaveBeenCalled();
        expect(onFocusHandled).toHaveBeenCalledTimes(1);
    });

    it("requests more pages when the focused media is not loaded yet and more remain", () => {
        const onFocusHandled = vi.fn();
        const onLoadMore = vi.fn();
        scrollToIndexMock.mockClear();

        renderWithMantine(
            <MediaGrid
                items={[createMedia({ id: 1, title: "First" })]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                focusMediaId={999}
                hasMore
                onLoadMore={onLoadMore}
                onFocusHandled={onFocusHandled}
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        // The target may be on a later page: keep paging (do not scroll or clear yet).
        expect(scrollToIndexMock).not.toHaveBeenCalled();
        expect(onLoadMore).toHaveBeenCalled();
        expect(onFocusHandled).not.toHaveBeenCalled();
    });

    describe("list semantics", () => {
        // Virtualization keeps only the rows near the viewport in the DOM, so a screen reader
        // cannot learn the size or its position by walking it. These pin the explicit roles and
        // set/position hints that carry that information instead.

        function renderGrid(hasMore: boolean): void {
            renderWithMantine(
                <MediaGrid
                    items={[
                        createMedia({ id: 1, title: "First" }),
                        createMedia({ id: 2, title: "Second" }),
                        createMedia({ id: 3, title: "Third" }),
                    ]}
                    libraryPath="/library"
                    shellBorder="rgba(255,255,255,0.1)"
                    shellSurface="rgba(255,255,255,0.03)"
                    loading={false}
                    hasMore={hasMore}
                    onLoadMore={vi.fn()}
                    onOpen={vi.fn()}
                    onRequestDelete={vi.fn()}
                />
            );
        }

        it("exposes each card as a positioned item of a list", () => {
            renderGrid(false);

            expect(screen.getByRole("list")).toBeInTheDocument();

            const items = screen.getAllByRole("listitem");
            expect(items).toHaveLength(3);

            // Every rendered card announces its own position within the whole set.
            expect(items.map((item) => item.getAttribute("aria-posinset"))).toEqual([
                "1",
                "2",
                "3",
            ]);
            // Fully loaded: the set size is known and real.
            expect(items.map((item) => item.getAttribute("aria-setsize"))).toEqual([
                "3",
                "3",
                "3",
            ]);
        });

        it("renders no stray text around the list", () => {
            renderGrid(false);

            // A `//` comment written in JSX children position is a text node, not a comment: it
            // ships as visible page text. The spot that invites the mistake is the scroll
            // container that wraps the list, so assert on structure rather than on any one
            // phrase - neither it nor the list itself may contribute text of its own; every
            // string on screen has to come from a card.
            const list = screen.getByRole("list");
            const containers = [list, list.parentElement].filter(
                (node): node is HTMLElement => node !== null
            );

            const strayText = containers.flatMap((container) =>
                Array.from(container.childNodes)
                    .filter((node) => node.nodeType === Node.TEXT_NODE)
                    .map((node) => node.textContent?.trim() ?? "")
                    .filter((text) => text.length > 0)
            );

            expect(strayText).toEqual([]);
        });

        it("reports an unknown set size while more pages remain", () => {
            renderGrid(true);

            // -1 is the ARIA value for "larger than what is rendered, total not known here":
            // claiming 3 would tell a screen reader the library ends at the loaded page.
            for (const item of screen.getAllByRole("listitem")) {
                expect(item.getAttribute("aria-setsize")).toBe("-1");
            }
        });
    });
});