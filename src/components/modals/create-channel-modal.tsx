import {
    Button,
    Group,
    Modal,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";
import type { ChannelAvatarMode } from "../../types/media";
import { NOOP } from "../../utils/noop";

type CreateChannelModalProps = {
    opened: boolean;
    onClose: () => void;
    channelName: string;
    youtubeHandle: string;
    avatarMode: ChannelAvatarMode;
    avatarPath: string;
    loading?: boolean;
    submitLabel?: string;
    title?: string;
    allowAvatarEditing?: boolean;
    onChangeChannelName: (value: string) => void;
    onChangeYoutubeHandle: (value: string) => void;
    onChangeAvatarMode: (value: ChannelAvatarMode) => void;
    onPickAvatar: () => void;
    onClearAvatar: () => void;
    onCreate: () => void;
};

export function CreateChannelModal({
    opened,
    onClose,
    channelName,
    youtubeHandle,
    avatarMode,
    avatarPath,
    loading = false,
    submitLabel = "Create",
    title = "New channel",
    allowAvatarEditing = true,
    onChangeChannelName,
    onChangeYoutubeHandle,
    onChangeAvatarMode,
    onPickAvatar,
    onClearAvatar,
    onCreate,
}: CreateChannelModalProps): JSX.Element {
    const requiresManualAvatar = allowAvatarEditing && avatarMode === "manual";
    const canSubmit =
        channelName.trim() !== "" &&
        youtubeHandle.trim() !== "" &&
        (!requiresManualAvatar || avatarPath.trim() !== "") &&
        !loading;

    const handleSubmit = (): void => {
        if (!canSubmit) {
            return;
        }

        onCreate();
    };

    return (
        <Modal
            opened={opened}
            onClose={loading ? NOOP : onClose}
            title={<Text fw={900}>{title}</Text>}
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
                    handleSubmit();
                }}
            >
                <Stack>
                    <TextInput
                        label="Name"
                        placeholder="e.g. Hardware Unboxed"
                        value={channelName}
                        onChange={(event) => onChangeChannelName(event.currentTarget.value)}
                        required
                        disabled={loading}
                        autoFocus
                    />

                    <TextInput
                        label="YouTube handle"
                        placeholder="@Hardwareunboxed"
                        value={youtubeHandle}
                        onChange={(event) => onChangeYoutubeHandle(event.currentTarget.value)}
                        description="Use formats like @channelname, channel/..., c/... or user/..."
                        required
                        disabled={loading}
                    />

                    {allowAvatarEditing && (
                        <Stack gap={6}>
                            <Text fw={700} size="sm">
                                Channel avatar
                            </Text>

                            <SegmentedControl
                                value={avatarMode}
                                onChange={(value) => onChangeAvatarMode(value as ChannelAvatarMode)}
                                data={[
                                    { label: "No avatar", value: "none" },
                                    { label: "Manual file", value: "manual" },
                                    { label: "From YouTube", value: "youtube" },
                                ]}
                                disabled={loading}
                            />

                            {avatarMode === "manual" && (
                                <>
                                    <TextInput
                                        label="Avatar file"
                                        value={avatarPath}
                                        placeholder="Select an image file"
                                        readOnly
                                        disabled={loading}
                                    />

                                    <Group>
                                        <Button
                                            type="button"
                                            variant="light"
                                            onClick={onPickAvatar}
                                            disabled={loading}
                                        >
                                            Choose file
                                        </Button>

                                        <Button
                                            type="button"
                                            variant="subtle"
                                            onClick={onClearAvatar}
                                            disabled={loading || !avatarPath.trim()}
                                        >
                                            Clear
                                        </Button>
                                    </Group>
                                </>
                            )}

                            {avatarMode === "youtube" && (
                                <Text size="sm" c="dimmed">
                                    The app will try to download the channel avatar from the registered
                                    YouTube handle using yt-dlp.
                                </Text>
                            )}
                        </Stack>
                    )}

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
                            {submitLabel}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}