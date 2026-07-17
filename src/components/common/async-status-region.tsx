import { Box, Group, Loader, Text } from "@mantine/core";
import type { ReactNode } from "react";

type AsyncStatusRegionProps = {
    loading: boolean;
    loadingMessage: string;
    error?: string | null;
    children?: ReactNode;
};

// The shared loading/error shell for the comments and live chat panels: a polite ARIA status
// region that shows a spinner while `loading`, the `error` text (in the alert colour) once a load
// has failed, and otherwise whatever settled-state content the panel passes as children (its own
// empty/filtered messages, which stay panel-specific). Extracted so the a11y attributes and the
// loading/error rendering are defined once and cannot drift between the two panels.
//
// Children are rendered unconditionally after the loading/error blocks, so each panel keeps its
// own exact showing conditions - one of them (the comments "fetch comments" action) is shown even
// when an error is present, so this shell must not gate children on `!error`.
export function AsyncStatusRegion({
    loading,
    loadingMessage,
    error = null,
    children,
}: AsyncStatusRegionProps): JSX.Element {
    return (
        <Box role="status" aria-live="polite">
            {loading && (
                <Group gap="sm">
                    <Loader size="sm" />
                    <Text size="sm" c="dimmed">
                        {loadingMessage}
                    </Text>
                </Group>
            )}

            {!loading && error && (
                <Text size="sm" c="red.4">
                    {error}
                </Text>
            )}

            {children}
        </Box>
    );
}
