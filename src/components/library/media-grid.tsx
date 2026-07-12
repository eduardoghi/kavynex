import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Card, Group, Stack, Text, Title } from "@mantine/core";
import { useElementSize, useWindowEvent } from "@mantine/hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaRow } from "../../types/media";
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
    const scrollParentRef = useRef<HTMLDivElement | null>(null);
    const savedScrollTopRef = useRef(0);
    const wasVisibleRef = useRef(isVisible);
    const isRestoringScrollRef = useRef(false);
    const restoreFrameRef = useRef<number | null>(null);
    const restoreSecondFrameRef = useRef<number | null>(null);
    const { ref: measureRef, width } = useElementSize();
    const [rowHeight, setRowHeight] = useState(MEDIA_CARD_HEIGHT);
    const [highlightedMediaId, setHighlightedMediaId] = useState<number | null>(null);
    const highlightTimerRef = useRef<number | null>(null);

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
            // Not loaded yet (or filtered out): wait for a later `items` change.
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
    }, [focusMediaId, items, columnCount, isVisible, rowVirtualizer, onFocusHandled]);

    useEffect(() => {
        return () => {
            if (highlightTimerRef.current !== null) {
                window.clearTimeout(highlightTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        const scrollElement = scrollParentRef.current;

        if (!scrollElement) {
            wasVisibleRef.current = isVisible;
            return;
        }

        const wasVisible = wasVisibleRef.current;

        if (wasVisible && !isVisible) {
            savedScrollTopRef.current = scrollElement.scrollTop;
        }

        if (!wasVisible && isVisible) {
            const savedScrollTop = savedScrollTopRef.current;

            isRestoringScrollRef.current = true;

            if (restoreFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreFrameRef.current);
                restoreFrameRef.current = null;
            }

            if (restoreSecondFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreSecondFrameRef.current);
                restoreSecondFrameRef.current = null;
            }

            restoreFrameRef.current = window.requestAnimationFrame(() => {
                scrollElement.scrollTop = savedScrollTop;

                restoreSecondFrameRef.current = window.requestAnimationFrame(() => {
                    scrollElement.scrollTop = savedScrollTop;
                    isRestoringScrollRef.current = false;
                    restoreSecondFrameRef.current = null;
                });

                restoreFrameRef.current = null;
            });
        }

        wasVisibleRef.current = isVisible;

        return () => {
            if (restoreFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreFrameRef.current);
                restoreFrameRef.current = null;
            }

            if (restoreSecondFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreSecondFrameRef.current);
                restoreSecondFrameRef.current = null;
            }

            isRestoringScrollRef.current = false;
        };
    }, [isVisible]);

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
                        onScroll={(event) => {
                            if (isRestoringScrollRef.current || !isVisible) {
                                return;
                            }

                            savedScrollTopRef.current = event.currentTarget.scrollTop;
                        }}
                        style={{
                            height: GRID_HEIGHT,
                            overflowY: "auto",
                            overflowX: "hidden",
                            position: "relative",
                        }}
                    >
                        <Box
                            style={{
                                height: `${rowVirtualizer.getTotalSize()}px`,
                                width: "100%",
                                position: "relative",
                            }}
                        >
                            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                                const rowItems = rows[virtualRow.index];

                                return (
                                    <Box
                                        key={virtualRow.key}
                                        ref={rowVirtualizer.measureElement}
                                        data-index={virtualRow.index}
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
                                                            ? (node) => {
                                                                  if (!node) {
                                                                      return;
                                                                  }

                                                                  const nextHeight =
                                                                      node.getBoundingClientRect().height;

                                                                  if (
                                                                      Number.isFinite(nextHeight) &&
                                                                      nextHeight > 0 &&
                                                                      Math.abs(nextHeight - rowHeight) > 2
                                                                  ) {
                                                                      setRowHeight(nextHeight);
                                                                  }
                                                              }
                                                            : undefined
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

                                            {Array.from({
                                                length: Math.max(0, columnCount - rowItems.length),
                                            }).map((_, fillerIndex) => (
                                                <Box
                                                    key={`filler-${virtualRow.index}-${fillerIndex}`}
                                                />
                                            ))}
                                        </Box>
                                    </Box>
                                );
                            })}
                        </Box>
                    </Box>
                </Box>
            )}
        </Stack>
    );
}