import { useRef } from "react";
import { Box, rem } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { UI_TEXT } from "../../constants/ui-text";
import { CommentContent } from "./comment-content";
import type { FlatCommentRow } from "./comment-tree";

// The scroll area the results live in. Virtualization needs a bounded, scrollable container (the
// same shape the media grid uses), so a comment search - unlike the naturally-growing browse view -
// gets its own inner scroll region.
const SEARCH_RESULTS_HEIGHT = 600;
// Per-level indent, matching the browse view's reply indentation closely enough to read as a thread.
const LEVEL_INDENT_PX = 24;
// A rough first guess at a row's height; real heights are measured after mount (measureElement), so
// this only affects the very first paint's scrollbar estimate, never final layout.
const ESTIMATED_ROW_HEIGHT = 140;
const ROW_GAP_PX = 16;

type CommentSearchResultsProps = {
    rows: FlatCommentRow[];
    shellBorder: string;
};

// Renders every comment matching the current search as a flat, virtualized list. Search deliberately
// shows all matches (the whole point of searching the full comment set), so it cannot lean on the
// browse view's thread/reply caps; virtualization is what keeps a broad query that matches thousands
// of comments from mounting them all at once. Each row is indented by its depth so the reply
// hierarchy still reads.
export function CommentSearchResults({
    rows,
    shellBorder,
}: CommentSearchResultsProps): JSX.Element {
    const scrollParentRef = useRef<HTMLDivElement | null>(null);

    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scrollParentRef.current,
        estimateSize: () => ESTIMATED_ROW_HEIGHT,
        overscan: 6,
    });

    const virtualRows = virtualizer.getVirtualItems();

    // Shrink the scroll area to the content when the results are short, and cap it at
    // SEARCH_RESULTS_HEIGHT (scrolling past that) when they are long - so a two-match search is not a
    // tall, mostly-empty box. getTotalSize is estimate-based before rows are measured and settles as
    // they mount, so this never collapses to zero.
    const scrollAreaHeight = Math.min(SEARCH_RESULTS_HEIGHT, virtualizer.getTotalSize());

    return (
        <Box
            ref={scrollParentRef}
            style={{
                height: `${scrollAreaHeight}px`,
                overflowY: "auto",
                overflowX: "hidden",
                position: "relative",
            }}
        >
            {/* Only the rows near the viewport exist in the DOM, so assistive tech cannot count the
                matches by walking them. The list role here plus aria-setsize/aria-posinset on each
                row restore that. */}
            <Box
                role="list"
                aria-label={UI_TEXT.comments.title}
                style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    width: "100%",
                    position: "relative",
                }}
            >
                {virtualRows.map((virtualRow) => {
                    const row = rows[virtualRow.index];

                    // The virtualizer only yields in-range indices, so this is never null in
                    // practice; the guard satisfies the checked-index type.
                    if (!row) {
                        return null;
                    }

                    return (
                        <Box
                            key={virtualRow.key}
                            ref={virtualizer.measureElement}
                            data-index={virtualRow.index}
                            role="presentation"
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualRow.start}px)`,
                                paddingBottom: rem(ROW_GAP_PX),
                            }}
                        >
                            <Box
                                role="listitem"
                                aria-setsize={rows.length}
                                aria-posinset={virtualRow.index + 1}
                                style={{
                                    marginLeft: rem(row.level * LEVEL_INDENT_PX),
                                    paddingLeft: row.level > 0 ? rem(14) : 0,
                                    borderLeft:
                                        row.level > 0 ? `1px solid ${shellBorder}` : undefined,
                                }}
                            >
                                <CommentContent
                                    comment={row.node}
                                    shellBorder={shellBorder}
                                    compact={row.level > 0}
                                />
                            </Box>
                        </Box>
                    );
                })}
            </Box>
        </Box>
    );
}
