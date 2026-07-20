import { useEffect, useState } from "react";
import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import type { MediaRow } from "../../types/media";
import { useModalLock } from "../../hooks/use-modal-lock";

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
            title={<Text fw={900}>Edit title</Text>}
            centered
            radius="lg"
            overlayProps={{ blur: 6 }}
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
                        autoFocus
                    />

                    <Group justify="flex-end">
                        <Button type="button" variant="subtle" onClick={onClose} disabled={loading}>
                            Cancel
                        </Button>

                        <Button
                            type="submit"
                            variant="gradient"
                            gradient={{ from: "violet", to: "cyan" }}
                            disabled={!canSubmit}
                            loading={loading}
                        >
                            Save
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}
