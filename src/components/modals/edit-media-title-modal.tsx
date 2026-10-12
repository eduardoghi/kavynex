import { useEffect, useState } from "react";
import { Group, Modal, Stack, TextInput } from "@mantine/core";
import type { MediaRow } from "../../types/media";
import { useModalLock } from "../../hooks/use-modal-lock";
import { AppButton } from "../ui/app-button";
import { MODAL_CLOSE_BUTTON_STYLE, MODAL_TITLE_STYLE } from "../ui/modal-chrome";

type EditMediaTitleModalProps = {
    media: MediaRow | null;
    loading?: boolean;
    onClose: () => void;
    onSave: (media: MediaRow, title: string) => void;
};

export function EditMediaTitleModal({
    media,
    loading = false,
    onClose,
    onSave,
}: EditMediaTitleModalProps): JSX.Element {
    const [title, setTitle] = useState("");

    useEffect(() => {
        if (media) {
            setTitle(media.title);
        }
    }, [media]);

    const trimmedTitle = title.trim();
    const canSubmit = trimmedTitle !== "" && !loading;

    const handleSubmit = (): void => {
        if (!media || !canSubmit) {
            return;
        }

        onSave(media, trimmedTitle);
    };

    const modalLock = useModalLock(loading, onClose);

    return (
        <Modal
            opened={media !== null}
            title="Edit title"
            centered
            radius="lg"
            overlayProps={{ blur: 6 }}
            styles={{ title: MODAL_TITLE_STYLE }}
            // Mantine's close button is an icon with no text, so it needs a name for a screen reader.
            closeButtonProps={{ "aria-label": "Close edit title", style: MODAL_CLOSE_BUTTON_STYLE }}
            {...modalLock}
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    handleSubmit();
                }}
            >
                <Stack>
                    <TextInput
                        label="Title"
                        value={title}
                        onChange={(event) => setTitle(event.currentTarget.value)}
                        required
                        disabled={loading}
                        // Mantine's focus trap, not React's autoFocus. The trap moves focus after
                        // React does, to `[data-autofocus]` or else the first tabbable element,
                        // which is the header's close button.
                        data-autofocus
                    />

                    <Group justify="flex-end">
                        <AppButton
                            type="button"
                            appVariant="secondary"
                            onClick={onClose}
                            disabled={loading}
                        >
                            Cancel
                        </AppButton>

                        <AppButton
                            type="submit"
                            appVariant="primary"
                            disabled={!canSubmit}
                            loading={loading}
                        >
                            Save
                        </AppButton>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}
