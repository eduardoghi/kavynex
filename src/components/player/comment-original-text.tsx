import { useState, type CSSProperties } from "react";
import { Box, Button, Stack, Text } from "@mantine/core";
import { UI_TEXT } from "../../constants/ui-text";

const ORIGINAL_TEXT_STYLE: CSSProperties = {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    lineHeight: 1.5,
};

// The same look as the show/hide-replies toggle in `CommentItem`, one size smaller, so the two
// open-and-close controls on a comment read as the same kind of thing.
const TOGGLE_BUTTON_STYLES = {
    root: {
        color: "var(--kx-color-link)",
        fontWeight: 700,
        alignSelf: "flex-start",
    },
} satisfies Record<string, CSSProperties>;

type CommentOriginalTextProps = {
    originalText: string;
};

// The text a comment had when it was first saved, behind a toggle, for a comment a later fetch
// brought back edited. Its own component so `CommentContent` stays stateless. A row the search list
// recycles starts collapsed again, which is the cheap and expected outcome.
export function CommentOriginalText({ originalText }: CommentOriginalTextProps): JSX.Element {
    const [open, setOpen] = useState(false);

    return (
        <Stack gap={4}>
            <Button
                variant="subtle"
                size="compact-xs"
                px={0}
                onClick={() => setOpen((current) => !current)}
                aria-expanded={open}
                styles={TOGGLE_BUTTON_STYLES}
            >
                {open ? UI_TEXT.comments.hideOriginalText : UI_TEXT.comments.showOriginalText}
            </Button>

            {open && (
                <Box
                    pl="sm"
                    style={{ borderLeft: "2px solid var(--mantine-color-default-border)" }}
                >
                    <Text size="xs" c="dimmed" mb={2}>
                        {UI_TEXT.comments.originalTextLabel}
                    </Text>
                    <Text size="sm" c="dimmed" style={ORIGINAL_TEXT_STYLE}>
                        {originalText}
                    </Text>
                </Box>
            )}
        </Stack>
    );
}
