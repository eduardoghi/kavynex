import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Card, Group, Stack, Text, Title } from "@mantine/core";
import { useElementSize, useWindowEvent } from "@mantine/hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaRow } from "../../types/media";
import { useGridScrollRestoration } from "../../hooks/use-grid-scroll-restoration";
import { LoadingStateCard } from "../common/loading-state-card";
import { MediaCard, MEDIA_CARD_HEIGHT } from "./media-card";

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
    onEditTitle?: (media: MediaRow) => void;
};

const GRID_GAP = 16;
const GRID_HEIGHT = "70vh";
// How long a card stays highlighted after the grid scrolls to it (e.g. from a diagnostics
// "jump to media" action) before the highlight fades.
const MEDIA_HIGHLIGHT_DURATION_MS = 2600;

function getColumnCount(width: number): number {
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
    // renders - an inline arrow function here would be reassigned on every scroll-driven
    // re-render, forcing React to call it again and re-run getBoundingClientRect (a synchronous
    // layout reflow) even though the measured node has not changed.
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

    const columnCount = useMemo(() => getColumnCount(width), [width]);

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
        overscan: 4,
    });

    const virtualRows = rowVirtualizer.getVirtualItems();

    // Infinite scroll: when the last virtualized row comes into view and the backend reports more
    // matching rows, ask for the next page. isLoadingMore guards against firing repeatedly while a
    // page is in flight.
    useEffect(() => {
        if (!isVisible || !hasMore || isLoadingMore || !onLoadMore) {
            return;
        }

        const lastRow = virtualRows[virtualRows.length - 1];

        if (lastRow && lastRow.index >= rows.length - 1) {
            onLoadMore();
        }
    }, [virtualRows, isVisible, hasMore, isLoadingMore, onLoadMore, rows.length]);

    // Jump to (and briefly highlight) a media requested from elsewhere - e.g. a "missing media"
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
                <LoadingStateCard
                    message={UI_TEXT.library.loading}
                    shellBorder={shellBorder}
                />
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
                                        ref={rowVirtualizer.measureElement}
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
                                                    // is not known here" - the grid only receives
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
                                                        shellBorder={shellBorder}
                                                        isActive={activeMediaId === media.id}
                                                        onOpen={onOpen}
                                                        onRequestDelete={onRequestDelete}
                                                        onOpenFileLocation={onOpenFileLocation}
                                                        onOpenSourceInYoutube={onOpenSourceInYoutube}
                                                        onMarkWatched={onMarkWatched}
                                                        onMarkUnwatched={onMarkUnwatched}
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