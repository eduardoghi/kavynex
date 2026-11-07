import { useState } from "react";
import { Alert, Button, Group, Stack, Switch, Text, Title } from "@mantine/core";
import { Trash2 } from "lucide-react";
import { ORPHAN_GRACE_PERIOD_DAYS } from "../../../constants/library-retention";
import type { LibraryTrashSummary } from "../../../types/generated/LibraryTrashSummary";
import { formatCount } from "../../../utils/pluralize";

type TrashSectionProps = {
    deleteSkipsTrash: boolean;
    onChangeDeleteSkipsTrash: (deleteSkipsTrash: boolean) => void;
    trashSummary: LibraryTrashSummary | null;
    isEmptyingTrash: boolean;
    trashError: string;
    onEmptyTrash: () => Promise<void>;
};

export function TrashSection({
    deleteSkipsTrash,
    onChangeDeleteSkipsTrash,
    trashSummary,
    isEmptyingTrash,
    trashError,
    onEmptyTrash,
}: TrashSectionProps): JSX.Element {
    const [isConfirmOpen, setIsConfirmOpen] = useState(false);
    const files = trashSummary?.files ?? 0;

    return (
        <Stack gap="xs">
            <Group gap="sm">
                <Trash2 size={18} />
                <Title order={3} size="h4">Deleted media</Title>
            </Group>

            <Switch
                checked={deleteSkipsTrash}
                onChange={(event) => onChangeDeleteSkipsTrash(event.currentTarget.checked)}
                label="Delete files right away"
                description={`When off, deleting a media or a channel moves its files to the library's .trash folder, where they stay for ${ORPHAN_GRACE_PERIOD_DAYS} days. A file can be copied back out of that folder by hand and imported again. When on, the files are deleted at once and cannot be recovered.`}
            />

            {trashSummary && (
                <Text size="sm" c="dimmed">
                    {files === 0
                        ? "The trash is empty."
                        : `The trash holds ${formatCount(files, "file")} (${trashSummary.formattedSize}).`}
                </Text>
            )}

            {isConfirmOpen ? (
                <Alert color="red" role="alertdialog" aria-label="Empty the trash">
                    <Stack gap="xs">
                        <Text size="sm">
                            {`Delete ${formatCount(files, "file")} in the trash for good? They cannot be recovered.`}
                        </Text>
                        <Group gap="xs">
                            <Button
                                color="red"
                                size="xs"
                                loading={isEmptyingTrash}
                                onClick={() => {
                                    void onEmptyTrash().finally(() => setIsConfirmOpen(false));
                                }}
                            >
                                Empty trash
                            </Button>
                            <Button
                                variant="default"
                                size="xs"
                                disabled={isEmptyingTrash}
                                onClick={() => setIsConfirmOpen(false)}
                            >
                                Cancel
                            </Button>
                        </Group>
                    </Stack>
                </Alert>
            ) : (
                <Group>
                    <Button
                        variant="light"
                        color="red"
                        size="xs"
                        disabled={files === 0 || isEmptyingTrash}
                        onClick={() => setIsConfirmOpen(true)}
                    >
                        Empty trash
                    </Button>
                </Group>
            )}

            {trashError && (
                <Text size="sm" c="red">
                    {trashError}
                </Text>
            )}
        </Stack>
    );
}
