import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { AlertTriangle, Info } from "lucide-react";
import type { ReactNode } from "react";
import { MODAL_CLOSE_BUTTON_STYLE } from "../ui/modal-chrome";

export type ErrorModalVariant = "error" | "notice";

type ErrorModalProps = {
    opened: boolean;
    onClose: () => void;
    variant?: ErrorModalVariant;
    title?: ReactNode;
    message: ReactNode;
    // Messages queued behind this one, which closing it shows next.
    pendingCount?: number;
};

export function ErrorModal({
    opened,
    onClose,
    variant = "error",
    title,
    message,
    pendingCount = 0,
}: ErrorModalProps): JSX.Element {
    const isNotice = variant === "notice";
    const color = isNotice ? "blue" : "red";
    const heading = isNotice ? "Notice" : "Error";
    const subheading = isNotice ? "Just so you know" : "Something went wrong";
    const Icon = isNotice ? Info : AlertTriangle;

    const resolvedTitle = title ?? (
        <Text fw={700} c={color}>
            {heading}
        </Text>
    );

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={resolvedTitle}
            centered
            radius="xl"
            overlayProps={{ blur: 8 }}
            zIndex={400}
            // Mantine's header close button is an icon with no text, so without this it has no
            // accessible name. "Dismiss" rather than "Close", because the footer button below is
            // already named "Close" and two controls sharing a name is the thing a screen reader
            // cannot tell apart.
            closeButtonProps={{ "aria-label": "Dismiss", style: MODAL_CLOSE_BUTTON_STYLE }}
        >
            <Stack gap="md">
                <Group gap="sm" align="center">
                    {/* The icon alone, in the semantic text colour, with no tinted disc. */}
                    <Icon
                        size={20}
                        color={isNotice ? "var(--kx-color-link)" : "var(--kx-color-error-text)"}
                        style={{ flexShrink: 0 }}
                        aria-hidden
                    />
                    <Text fw={700}>{subheading}</Text>
                </Group>

                <Text
                    aria-live={isNotice ? "polite" : "assertive"}
                    style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                    }}
                >
                    {message}
                </Text>

                <Group justify={pendingCount > 0 ? "space-between" : "flex-end"}>
                    {pendingCount > 0 && (
                        <Text size="sm" c="dimmed">
                            {pendingCount === 1
                                ? "1 more message after this one"
                                : `${pendingCount} more messages after this one`}
                        </Text>
                    )}
                    <Button type="button" color={color} onClick={onClose}>
                        Close
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
