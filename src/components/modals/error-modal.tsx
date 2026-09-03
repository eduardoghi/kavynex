import { Button, Group, Modal, Stack, Text, ThemeIcon } from "@mantine/core";
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
};

export function ErrorModal({
    opened,
    onClose,
    variant = "error",
    title,
    message,
}: ErrorModalProps): JSX.Element {
    const isNotice = variant === "notice";
    const color = isNotice ? "blue" : "red";
    const heading = isNotice ? "Notice" : "Error";
    const subheading = isNotice ? "Just so you know" : "Something went wrong";
    const Icon = isNotice ? Info : AlertTriangle;

    const resolvedTitle = title ?? (
        <Text fw={900} c={color}>
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
                    <ThemeIcon color={color} variant="light" radius="xl" size="lg">
                        <Icon size={18} />
                    </ThemeIcon>
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

                <Group justify="flex-end">
                    <Button type="button" color={color} onClick={onClose}>
                        Close
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
