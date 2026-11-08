import type { ReactNode } from "react";
import { Box, Group, Stack, rem } from "@mantine/core";

type ChatCardProps = {
    background: string;
    border?: string;
    // The text color inside the card. Left out, the card keeps the panel's.
    color?: string;
    children: ReactNode;
};

/** The rounded card a membership announcement, a pinned message and a Super Chat sit in. */
export function ChatCard({ background, border, color, children }: ChatCardProps): JSX.Element {
    return (
        <Group align="flex-start" gap="sm" wrap="nowrap">
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                <Box
                    style={{
                        background,
                        border,
                        color,
                        borderRadius: rem(8),
                        padding: rem(8),
                    }}
                >
                    {children}
                </Box>
            </Stack>
        </Group>
    );
}
