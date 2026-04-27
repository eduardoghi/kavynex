import { Button, Group, Modal, Stack, Text, ThemeIcon } from "@mantine/core";
import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

type ErrorModalProps = {
    opened: boolean;
    onClose: () => void;
    title?: ReactNode;
    message: ReactNode;
};

export function ErrorModal({
    opened,
    onClose,
    title = (
        <Text fw={900} c="red">
            Error
        </Text>
    ),
    message,
}: ErrorModalProps): JSX.Element {
    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={title}
            centered
            radius="xl"
            overlayProps={{ blur: 8 }}
            zIndex={400}
        >
            <Stack gap="md">
                <Group gap="sm" align="center">
                    <ThemeIcon color="red" variant="light" radius="xl" size="lg">
                        <AlertTriangle size={18} />
                    </ThemeIcon>
                    <Text fw={700}>Something went wrong</Text>
                </Group>

                <Text
                    aria-live="assertive"
                    style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                    }}
                >
                    {message}
                </Text>

                <Group justify="flex-end">
                    <Button type="button" color="red" onClick={onClose}>
                        Close
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}