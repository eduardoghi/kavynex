import { Box, Card, Skeleton, Stack } from "@mantine/core";
import { MEDIA_CARD_HEIGHT } from "./media-card";

// How many placeholder cards to show while the first page loads. Roughly two rows at the widest
// column count, enough to fill the fold without implying a specific result count.
const SKELETON_CARD_COUNT = 8;
const SKELETON_THUMBNAIL_HEIGHT = 158;
const GRID_GAP = 16;

// A placeholder grid shown while the first page of media loads, shaped like the real cards
// (thumbnail block, two title lines, a footer line) so the layout does not jump when data arrives.
// Reads as a faster, more finished load than a centered spinner. Purely decorative. The loading
// state's announcement lives on the status region that wraps this in the grid.
export function MediaGridSkeleton({ shellBorder }: { shellBorder: string }): JSX.Element {
    return (
        <Box
            aria-hidden
            style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: GRID_GAP,
            }}
        >
            {Array.from({ length: SKELETON_CARD_COUNT }, (_, index) => (
                <Card
                    key={index}
                    withBorder
                    radius="lg"
                    p="sm"
                    style={{ height: MEDIA_CARD_HEIGHT, borderColor: shellBorder }}
                >
                    <Stack gap="sm" h="100%">
                        <Skeleton height={SKELETON_THUMBNAIL_HEIGHT} radius="md" />
                        <Skeleton height={12} width="90%" radius="sm" />
                        <Skeleton height={12} width="55%" radius="sm" />
                        <Skeleton height={10} width="40%" radius="sm" mt="auto" />
                    </Stack>
                </Card>
            ))}
        </Box>
    );
}
