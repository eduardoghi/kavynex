import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { Trash2 } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { useModalLock } from "../../hooks/use-modal-lock";
import { MODAL_CLOSE_BUTTON_STYLE } from "../ui/modal-chrome";

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
    // Only the Cancel button dismisses it: no Esc, no click outside, no close button. For a prompt
    // that does not come back once dismissed, so a stray key cannot be the decision.
    requireExplicitChoice?: boolean;
    // Which button takes focus when the modal opens. Cancel by default, so Enter on a destructive
    // prompt does nothing destructive. "confirm" is for a prompt whose cancel slot is the risky one.
    autoFocus?: "cancel" | "confirm";
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
    requireExplicitChoice = false,
    autoFocus = "cancel",
}: ConfirmDeleteModalProps): JSX.Element {
    const modalLock = useModalLock(loading || requireExplicitChoice, onClose);

    // What the modal keeps showing while it fades out. The caller clears its target in the same
    // tick it closes the modal after a delete, so the live props would turn "Delete **My video**?"
    // into "Delete **this item**?" during the exit transition.
    const shown = useRef({ message, description });

    if (opened) {
        shown.current = { message, description };
    }

    return (
        <Modal
            opened={opened}
            title={title}
            centered
            radius="lg"
            overlayProps={{ blur: 6 }}
            // Mantine's header close button is an icon with no text, so without this it has no
            // accessible name. The label is "Close" rather than a variant of the confirm/cancel
            // pair below it, which is what the footer already offers under their own names.
            closeButtonProps={{ "aria-label": "Close", style: MODAL_CLOSE_BUTTON_STYLE }}
            {...modalLock}
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
                    <Text aria-live="polite">{shown.current.message}</Text>

                    {shown.current.description && (
                        <Text c="dimmed" size="sm">
                            {shown.current.description}
                        </Text>
                    )}

                    <Group justify="flex-end">
                        <Button
                            type="button"
                            variant="subtle"
                            onClick={onClose}
                            disabled={loading}
                            data-autofocus={autoFocus === "cancel" || undefined}
                        >
                            {cancelLabel}
                        </Button>

                        <Button
                            type="submit"
                            color={confirmColor}
                            leftSection={confirmIcon}
                            loading={loading}
                            data-autofocus={autoFocus === "confirm" || undefined}
                        >
                            {confirmLabel}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}