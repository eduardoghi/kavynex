import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Card, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { useElementSize, useWindowEvent } from "@mantine/hooks";
import { useVirtualizer } from "@tanstack/react-virtual";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaRow } from "../../types/media";
import { MediaCard, MEDIA_CARD_HEIGHT } from "./media-card";

type MediaGridProps = {
    items: MediaRow[];
    libraryPath: string;
    shellBorder: string;
    shellSurface: string;
    activeMediaId?: number | null;
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
                <Card
                    withBorder
                    radius="xl"
                    p="xl"
                    style={{ background: shellSurface, borderColor: shellBorder }}
                >
                    <Stack align="center" gap="sm">
                        <Loader size="sm" />
                        <Text c="dimmed">{UI_TEXT.library.loading}</Text>
                    </Stack>
                </Card>
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