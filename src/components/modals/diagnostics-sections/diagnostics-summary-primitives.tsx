import type { ReactNode } from "react";
import { Badge, Box, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";

// The presentational primitives the diagnostics sections share. Kept in their own module so each
// section reads as layout, and so the issues section styles its badges the same way instead of
// copying them. Nothing here knows what a section is about: a heading is a glyph and a word, a
// metric is a label over a value, and the list is whatever strings it is handed.

export function StatusBadge({
    color,
    label,
}: {
    color: "green" | "yellow" | "red" | "gray" | "blue";
    label: string;
}): JSX.Element {
    return (
        <Badge color={color} variant="light">
            {label}
        </Badge>
    );
}

type SectionHeadingProps = {
    icon?: ReactNode;
    title: string;
};

// A heading is a glyph and a word. It used to be a word behind a 34px violet gradient tile with a
// shadow, repeated five times down a dialog meant to be read rather than admired.
export function SectionHeading({ icon, title }: SectionHeadingProps): JSX.Element {
    return (
        <Group gap={8} wrap="nowrap" align="center">
            {icon && (
                <Box component="span" c="dimmed" style={{ display: "flex", flexShrink: 0 }}>
                    {icon}
                </Box>
            )}

            <Title order={4}>{title}</Title>
        </Group>
    );
}

type DiagnosticsMetricProps = {
    label: string;
    value: string | number;
};

// Label directly above its value, no box. Reading down a column of these is faster than reading
// across a row with the label at one edge and the number at the other, and it drops the card the
// value used to sit in without spreading the pair apart to compensate.
export function DiagnosticsMetric({ label, value }: DiagnosticsMetricProps): JSX.Element {
    return (
        <Box style={{ minWidth: 0 }}>
            <Text size="xs" c="dimmed" lineClamp={1}>
                {label}
            </Text>

            <Text fw={800} lh={1.3} lineClamp={1}>
                {value}
            </Text>
        </Box>
    );
}

// The metrics grid. Column spacing is what separates one metric from the next, since neither has a
// border any more.
export function DiagnosticsMetricGrid({ children }: { children: ReactNode }): JSX.Element {
    return (
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="lg" verticalSpacing="sm">
            {children}
        </SimpleGrid>
    );
}

type DiagnosticsExamplesListProps = {
    label: string;
    items: string[];
};

// A labelled list of example paths, or nothing at all when there are none: an empty heading over
// no items would only say that a category exists, which the metric above it already does.
export function DiagnosticsExamplesList({
    label,
    items,
}: DiagnosticsExamplesListProps): JSX.Element | null {
    if (items.length === 0) {
        return null;
    }

    return (
        <Box>
            <Text fw={700} size="sm" mb={4}>
                {label}
            </Text>

            <Stack gap={2}>
                {items.map((item) => (
                    <Text key={item} size="sm" c="dimmed">
                        {item}
                    </Text>
                ))}
            </Stack>
        </Box>
    );
}
