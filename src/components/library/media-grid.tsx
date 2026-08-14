import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Card, Group, Stack, Text, Title, VisuallyHidden } from "@mantine/core";
import { useElementSize, useWindowEvent } from "@mantine/hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaRow } from "../../types/media";
import { useGridScrollRestoration } from "../../hooks/use-grid-scroll-restoration";
import { MediaGridSkeleton } from "./media-grid-skeleton";
import { MediaCard, MEDIA_CARD_HEIGHT } from "./media-card";
import { useDisplayThumbnails } from "../../hooks/use-display-thumbnails";

type MediaGridProps = {
    items: MediaRow[];
    libraryPath: string;
    shellBorder: string;
    shellSurface: string;
    activeMediaId?: number | null;
    // When set to a media id present in `items`, the grid scrolls to that card and briefly
    // highlights it, then calls onFocusHandled. Used to jump to a media from Diagnostics.
    focusMediaId?: number | null;
    onFocusHandled?: () => void;
    // Server-side pagination: the grid appends the next page as the user scrolls near the bottom.
    hasMore?: boolean;
    isLoadingMore?: boolean;
    onLoadMore?: () => void;
    loading?: boolean;
    isVisible?: boolean;
    emptyTitle?: string;
    emptyDescription?: string;
    onOpen: (media: MediaRow) => void;
    onRequestDelete: (media: MediaRow) => void;
    onOpenFileLocation?: (media: MediaRow) => void;
    onOpenSourceInYoutube?: (media: MediaRow) => void;
    onMarkWatched?: (media: MediaRow) => void;
    onMarkUnwatched?: (media: MediaRow) => void;
    // See MediaLibraryController.watchedActionInFlight. Resolved per card below so a card only
    // shows its own watch/unwatch action as busy while that row's toggle is in flight.
    watchedActionInFlight?: ReadonlySet<number>;
    onEditTitle?: (media: MediaRow) => void;
};

const GRID_GAP = 16;

// Space held between the rightmost column and the scroll area's own scrollbar. Without it a card's
// border sits flush against the scrollbar, and the card highlight is worse off than that: it draws
// a 2px outline at `outlineOffset: 2` (see the focus/jump highlight below), so a highlighted card in
// the last column had four pixels of ring with nowhere to go.
//
// Set to GRID_GAP so the gutter to the scrollbar reads as the same distance as the gutter between
// two cards, rather than as a second, arbitrary measurement.
const GRID_SCROLLBAR_GUTTER = GRID_GAP;

// Roughly what sits above the grid inside the viewport: the app shell's padding, the channel
// header, the filter row and the grid's own title. Deliberately an approximation rather than a
// measurement. Reading it would mean a layout query on a container that re-renders on every scroll
// tick, which is the cost this file already refuses to pay for row heights (see measureFirstRow).
// Being a little wrong costs a few pixels of outer page scroll; measuring costs a reflow per frame.
const GRID_CHROME_ABOVE = 300;

// The inner scroll area the virtualizer measures against. This was a flat `70vh`, which is wrong in
// both directions once the window is not about 1080 tall: on a short window the grid plus the chrome
// above it overflow, so the page scrolls behind a grid that is itself scrolling, and on a tall one a
// fixed fraction leaves viewport unused that a fourth row would have filled.
//
// The floor is one full card row plus its gap. Below that the inner area cannot show a single
// complete card, and the outer page scroll ends up doing all the work, which is the state the
// nested scroll container exists to avoid.
const GRID_HEIGHT = `max(${MEDIA_CARD_HEIGHT + GRID_GAP}px, calc(100vh - ${GRID_CHROME_ABOVE}px))`;

// How long a card stays highlighted after the grid scrolls to it (e.g. from a diagnostics
// "jump to media" action) before the highlight fades.
const MEDIA_HIGHLIGHT_DURATION_MS = 2600;

// The widest a card is allowed to get before another column is added instead.
//
// A card's thumbnail is drawn from the display-sized derivative, which is capped at
// DISPLAY_THUMBNAIL_MAX_WIDTH (640) in services/thumbnail/display.rs. Stopping at four columns meant
// a 2560-wide window gave each card roughly 620px and a 3840-wide one gave it well past the cap, so
// the largest monitors were the ones being served an upscaled image. The opposite of what the
// derivative cache is for. Adding columns keeps the drawn width under the cap and fits more of the
// library on screen, which is what the extra width is for.
const MAX_CARD_WIDTH = 420;

export function getColumnCount(width: number): number {
    if (width >= 6 * MAX_CARD_WIDTH) {
        return 6;
    }

    if (width >= 5 * MAX_CARD_WIDTH) {
        return 5;
    }

    if (width >= 1200) {
        return 4;
    }

    if (width >= 992) {
        return 3;
    }

    if (width >= 768) {
        return 2;
    }

    return 1;
}

export function MediaGrid({
    items,
    libraryPath,
    shellBorder,
    shellSurface,
    activeMediaId = null,
    focusMediaId = null,
    onFocusHandled,
    hasMore = false,
    isLoadingMore = false,
    onLoadMore,
    loading = false,
    isVisible = true,
    emptyTitle = UI_TEXT.library.emptyTitle,
    emptyDescription = UI_TEXT.library.emptyDescription,
    onOpen,
    onRequestDelete,
    onOpenFileLocation,
    onOpenSourceInYoutube,
    onMarkWatched,
    onMarkUnwatched,
    watchedActionInFlight,
    onEditTitle,
}: MediaGridProps): JSX.Element {
    const hasItems = items.length > 0;
    const { scrollParentRef, onScroll } = useGridScrollRestoration(isVisible);
    const { ref: measureRef, width } = useElementSize();
    const [rowHeight, setRowHeight] = useState(MEDIA_CARD_HEIGHT);
    const [highlightedMediaId, setHighlightedMediaId] = useState<number | null>(null);
    const highlightTimerRef = useRef<number | null>(null);

    // Measures the first row's actual height so the virtualizer's row estimate can be corrected
    // once real cards are on screen. Memoized so the ref callback keeps a stable identity across
    // renders. An inline arrow function here would be reassigned on every scroll-driven
    // re-render, forcing React to call it again and re-run getBoundingClientRect (a synchronous
    // layout reflow) even though the measured node has not changed.
    //
    // This one measurement is also why the rows below deliberately do NOT take the virtualizer's
    // `measureElement` ref. Rows are uniform by construction (each is exactly one card tall, and
    // MEDIA_CARD_HEIGHT pins the card with the thumbnail, title and footer all fixed), so the only
    // thing that can move the real height is the root font size behind `rem()`, which this catches
    // once. `measureElement` would instead attach a ResizeObserver to every rendered row and read
    // layout as rows mount and unmount during a scroll, to re-derive a height that is already known
    // exactly. Re-add it only if a row's height ever becomes content-dependent.
    const measureFirstRow = useCallback(
        (node: HTMLDivElement | null) => {
            if (!node) {
                return;
            }

            const nextHeight = node.getBoundingClientRect().height;

            if (
                Number.isFinite(nextHeight) &&
                nextHeight > 0 &&
                Math.abs(nextHeight - rowHeight) > 2
            ) {
                setRowHeight(nextHeight);
            }
        },
        [rowHeight]
    );

    // Measured on the outer box, so the gutter reserved for the scrollbar has to come off before the
    // breakpoints are applied: the cards divide what is left, not what was measured. Without the
    // subtraction a window sitting just above a breakpoint would be given a column that then has
    // GRID_SCROLLBAR_GUTTER less room than the breakpoint was chosen for.
    const columnCount = useMemo(
        () => getColumnCount(Math.max(0, width - GRID_SCROLLBAR_GUTTER)),
        [width]
    );

    // Display-sized copies of the thumbnails on screen, so a card decodes a few hundred pixels
    // rather than the stored file's full resolution. Resolved for every loaded item rather than only
    // the virtualized window: the window changes on every scroll tick, and asking per tick would
    // turn a scroll into a stream of IPC calls. Purely an optimization. A path with no entry here
    // renders the stored thumbnail, which is what every card did before this existed.
    const displayThumbnails = useDisplayThumbnails(
        useMemo(() => items.map((item) => item.thumbnail_path), [items]),
        libraryPath
    );

    const rows = useMemo(() => {
        const groupedRows: MediaRow[][] = [];

        for (let index = 0; index < items.length; index += columnCount) {
            groupedRows.push(items.slice(index, index + columnCount));
        }

        return groupedRows;
    }, [items, columnCount]);

    const rowVirtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollParentRef.current,
        estimateSize: () => rowHeight + GRID_GAP,
        // Every row is exactly one card tall (MEDIA_CARD_HEIGHT, with the thumbnail, title and
        // footer all pinned), so estimateSize above is the real height rather than a guess and each
        // overscanned row is a full row of cards that must be built, laid out and (the dominant
        // cost) have its thumbnails decoded. A YouTube thumbnail decodes to width * height * 4
        // bytes whatever its file size, so each extra row of four is several megabytes of bitmap
        // held for rows the user cannot see. Two is enough to cover a fast flick without paying for
        // eight off-screen rows.
        overscan: 2,
    });

    const virtualRows = rowVirtualizer.getVirtualItems();

    // The index of the last row currently rendered, which is the only thing the infinite-scroll
    // effect below reads out of the virtualizer. Depending on the number rather than on
    // `virtualRows` is what keeps that effect from re-running on frames where nothing it cares
    // about moved: `getVirtualItems()` returns a freshly built array on every render, and this
    // component re-renders on every scroll tick (that is what `useVirtualizer` does), so the effect
    // was running, re-evaluating its four guards and returning, once per frame of every scroll.
    const lastVisibleRowIndex = virtualRows[virtualRows.length - 1]?.index ?? -1;

    // Infinite scroll: when the last virtualized row comes into view and the backend reports more
    // matching rows, ask for the next page. isLoadingMore guards against firing repeatedly while a
    // page is in flight.
    useEffect(() => {
        if (!isVisible || !hasMore || isLoadingMore || !onLoadMore) {
            return;
        }

        // -1 is "no rows rendered", which the comparison below would otherwise read as the last row
        // of an empty list and turn into a page request against nothing.
        if (lastVisibleRowIndex >= 0 && lastVisibleRowIndex >= rows.length - 1) {
            onLoadMore();
        }
    }, [lastVisibleRowIndex, isVisible, hasMore, isLoadingMore, onLoadMore, rows.length]);

    // Jump to (and briefly highlight) a media requested from elsewhere. E.g. a "missing media"
    // path clicked in Diagnostics. The target channel's media loads asynchronously, so this runs
    // again as `items` fills in; it acts only once the target is present, then clears the request.
    // onFocusHandled clears `focusMediaId` upstream, which re-runs this with a null id (a no-op);
    // the scroll and the highlight timer are intentionally not tied to this effect's cleanup so
    // that clear cannot cancel them.
    useEffect(() => {
        if (focusMediaId === null || !isVisible) {
            return;
        }

        const index = items.findIndex((item) => item.id === focusMediaId);

        if (index < 0) {
            // Not on the loaded page(s). With server-side pagination the target may be further
            // down, so keep loading pages until it appears (this effect re-runs as `items` grows).
            // Once there are no more pages it is not in the current filtered set, so give up and
            // clear the request instead of waiting forever.
            if (hasMore) {
                if (!isLoadingMore) {
                    onLoadMore?.();
                }

                return;
            }

            onFocusHandled?.();
            return;
        }

        const rowIndex = Math.floor(index / columnCount);
        rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });

        setHighlightedMediaId(focusMediaId);

        if (highlightTimerRef.current !== null) {
            window.clearTimeout(highlightTimerRef.current);
        }

        highlightTimerRef.current = window.setTimeout(() => {
            setHighlightedMediaId(null);
            highlightTimerRef.current = null;
        }, MEDIA_HIGHLIGHT_DURATION_MS);

        onFocusHandled?.();
    }, [
        focusMediaId,
        items,
        columnCount,
        isVisible,
        rowVirtualizer,
        onFocusHandled,
        hasMore,
        isLoadingMore,
        onLoadMore,
    ]);

    useEffect(() => {
        return () => {
            if (highlightTimerRef.current !== null) {
                window.clearTimeout(highlightTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!isVisible) {
            return;
        }

        rowVirtualizer.measure();
    }, [isVisible, columnCount, rowHeight, rowVirtualizer, items.length]);

    useWindowEvent("resize", () => {
        if (!isVisible) {
            return;
        }

        rowVirtualizer.measure();
    });

    return (
        <Stack gap="md">
            <Group justify="space-between" align="center" wrap="wrap">
                <Title order={3} fw={900}>
                    {UI_TEXT.library.title}
                </Title>
            </Group>

            {loading && (
                <Box role="status">
                    <VisuallyHidden>{UI_TEXT.library.loading}</VisuallyHidden>
                    <MediaGridSkeleton shellBorder={shellBorder} />
                </Box>
            )}

            {!loading && !hasItems && (
                <Card
                    withBorder
                    radius="xl"
                    p="xl"
                    style={{ background: shellSurface, borderColor: shellBorder }}
                >
                    <Stack gap="xs">
                        <Title order={4} fw={900}>
                            {emptyTitle}
                        </Title>

                        <Text c="dimmed">{emptyDescription}</Text>
                    </Stack>
                </Card>
            )}

            {!loading && hasItems && (
                <Box ref={measureRef}>
                    <Box
                        ref={scrollParentRef}
                        onScroll={onScroll}
                        style={{
                            height: GRID_HEIGHT,
                            overflowY: "auto",
                            overflowX: "hidden",
                            position: "relative",
                            paddingRight: GRID_SCROLLBAR_GUTTER,
                        }}
                    >
                        {/* Only the rows near the viewport exist in the DOM, so assistive tech
                            cannot count the media by walking it. The list role here, plus
                            aria-setsize/aria-posinset on each card below, restore that. The rows
                            and the grid inside them are pure layout (the column count is just a
                            responsive reflow), so they are marked presentational and the cards
                            stay the list's own items. */}
                        <Box
                            role="list"
                            aria-label={UI_TEXT.library.title}
                            style={{
                                height: `${rowVirtualizer.getTotalSize()}px`,
                                width: "100%",
                                position: "relative",
                            }}
                        >
                            {virtualRows.map((virtualRow) => {
                                const rowItems = rows[virtualRow.index];

                                // The virtualizer only yields in-range row indices, so this is
                                // never null in practice; the guard satisfies the checked-index
                                // type and renders nothing rather than crashing if it ever were.
                                if (!rowItems) {
                                    return null;
                                }

                                return (
                                    <Box
                                        key={virtualRow.key}
                                        data-index={virtualRow.index}
                                        role="presentation"
                                        style={{
                                            position: "absolute",
                                            top: 0,
                                            left: 0,
                                            width: "100%",
                                            transform: `translateY(${virtualRow.start}px)`,
                                            paddingBottom: GRID_GAP,
                                        }}
                                    >
                                        <Box
                                            role="presentation"
                                            style={{
                                                display: "grid",
                                                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                                                gap: GRID_GAP,
                                                alignItems: "start",
                                            }}
                                        >
                                            {rowItems.map((media, itemIndex) => (
                                                <Box
                                                    key={media.id}
                                                    ref={
                                                        virtualRow.index === 0 && itemIndex === 0
                                                            ? measureFirstRow
                                                            : undefined
                                                    }
                                                    role="listitem"
                                                    // -1 is the ARIA value for "the full set is
                                                    // larger than what is rendered, and its size
                                                    // is not known here". The grid only receives
                                                    // the pages loaded so far. Once the last page
                                                    // is in, the real count is known.
                                                    aria-setsize={hasMore ? -1 : items.length}
                                                    aria-posinset={
                                                        virtualRow.index * columnCount +
                                                        itemIndex +
                                                        1
                                                    }
                                                    style={{
                                                        borderRadius: 18,
                                                        outline:
                                                            media.id === highlightedMediaId
                                                                ? "2px solid var(--mantine-color-violet-5)"
                                                                : "2px solid transparent",
                                                        outlineOffset: 2,
                                                        transition: "outline-color 220ms ease",
                                                    }}
                                                >
                                                    <MediaCard
                                                        media={media}
                                                        libraryPath={libraryPath}
                                                        displayThumbnailPath={
                                                            media.thumbnail_path
                                                                ? displayThumbnails.get(
                                                                      media.thumbnail_path
                                                                  )
                                                                : undefined
                                                        }
                                                        shellBorder={shellBorder}
                                                        isActive={activeMediaId === media.id}
                                                        onOpen={onOpen}
                                                        onRequestDelete={onRequestDelete}
                                                        onOpenFileLocation={onOpenFileLocation}
                                                        onOpenSourceInYoutube={onOpenSourceInYoutube}
                                                        onMarkWatched={onMarkWatched}
                                                        onMarkUnwatched={onMarkUnwatched}
                                                        isWatchedActionInFlight={
                                                            watchedActionInFlight?.has(
                                                                media.id
                                                            ) ?? false
                                                        }
                                                        onEditTitle={onEditTitle}
                                                    />
                                                </Box>
                                            ))}

                                            {/* Empty cells that keep the last row's columns
                                                aligned. Presentational so they are never
                                                announced or counted as list items. */}
                                            {Array.from({
                                                length: Math.max(0, columnCount - rowItems.length),
                                            }).map((_, fillerIndex) => (
                                                <Box
                                                    key={`filler-${virtualRow.index}-${fillerIndex}`}
                                                    role="presentation"
                                                />
                                            ))}
                                        </Box>
                                    </Box>
                                );
                            })}
                        </Box>

                        {isLoadingMore && (
                            <Box style={{ textAlign: "center", paddingBlock: GRID_GAP }}>
                                <Text size="sm" c="dimmed" aria-live="polite">
                                    {UI_TEXT.library.loadingMore}
                                </Text>
                            </Box>
                        )}
                    </Box>
                </Box>
            )}
        </Stack>
    );
}