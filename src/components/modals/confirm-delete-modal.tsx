import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { Trash2 } from "lucide-react";
import type { ReactNode } from "react";

type ConfirmDeleteModalProps = {
    opened: boolean;
    onClose: () => void;
    onConfirm: () => void;

    title?: ReactNode;
    message: ReactNode;
    description?: ReactNode;

    confirmLabel?: string;
    cancelLabel?: string;
    confirmColor?: string;
    confirmIcon?: ReactNode;
    loading?: boolean;
};

export function ConfirmDeleteModal({
    opened,
    onClose,
    onConfirm,
    title = <Text fw={900}>Delete</Text>,
    message,
    description,
    confirmLabel = "Delete",
    cancelLabel = "Cancel",
    confirmColor = "red",
    confirmIcon = <Trash2 size={18} />,
    loading = false,
}: ConfirmDeleteModalProps): JSX.Element {
    return (
        <Modal
            opened={opened}
            onClose={loading ? () => {} : onClose}
            title={title}
            centered
            radius="lg"
            overlayProps={{ blur: 6 }}
            closeOnClickOutside={!loading}
            closeOnEscape={!loading}
            withCloseButton={!loading}
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();

                    if (loading) {
                        return;
                    }

                    onConfirm();
                }}
            >
                <Stack>
                    <Text aria-live="polite">{message}</Text>

                    {description && (
                        <Text c="dimmed" size="sm">
                            {description}
                        </Text>
                    )}

                    <Group justify="flex-end">
                        <Button
                            type="button"
                            variant="subtle"
                            onClick={onClose}
                            disabled={loading}
                            data-autofocus
                        >
                            {cancelLabel}
                        </Button>

                        <Button
                            type="submit"
                            color={confirmColor}
                            leftSection={confirmIcon}
                            loading={loading}
                        >
                            {confirmLabel}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}