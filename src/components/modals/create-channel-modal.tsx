import type { CSSProperties } from "react";
import {
    Button,
    Group,
    Modal,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
    Tooltip,
    rem,
} from "@mantine/core";
import { X } from "lucide-react";
import type { ChannelAvatarMode } from "../../types/media";
import { useModalLock } from "../../hooks/use-modal-lock";
import { toUnionValue } from "../../utils/guards";
import { AppButton } from "../ui/app-button";
import { fileNameFromPath } from "../../utils/media-utils";
import { MODAL_CLOSE_BUTTON_STYLE, MODAL_TITLE_STYLE } from "../ui/modal-chrome";

const CLEAR_BUTTON_STYLES = {
    // Clear sits next to Choose file and is the lesser of the two, so it stays neutral
    // until it is pointed at. Only the hover background is overridden, which leaves padding
    // and height matching Choose file and keeps the control from moving under the pointer.
    // The red is low enough to read as a warm hint rather than as a destructive button.
    root: {
        "--button-hover": "light-dark(rgba(239,68,68,0.10), rgba(239,68,68,0.16))",
    },
    // Mantine's default section margin left the glyph far enough from the word to read as a
    // second control. Same tightening the reply toggle in comment-item uses.
    section: {
        marginRight: rem(4),
    },
} as Record<string, CSSProperties>;

type CreateChannelModalProps = {
    opened: boolean;
    onClose: () => void;
    channelName: string;
    youtubeHandle: string;
    avatarMode: ChannelAvatarMode;
    avatarPath: string;
    loading?: boolean;
    submitLabel?: string;
    // What the submit button says while the request is in flight. Mantine's `loading`
    // hides the label and leaves a filled rectangle holding a spinner, so the state is
    // spelled out instead.
    submitLoadingLabel?: string;
    title?: string;
    allowAvatarEditing?: boolean;
    onChangeChannelName: (value: string) => void;
    onChangeYoutubeHandle: (value: string) => void;
    // Avatar handlers are only used when `allowAvatarEditing` is true (the avatar section is not
    // rendered otherwise), so they are optional: the edit-channel reuse of this modal omits them
    // instead of passing no-ops.
    onChangeAvatarMode?: (value: ChannelAvatarMode) => void;
    onPickAvatar?: () => void;
    onClearAvatar?: () => void;
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
    submitLoadingLabel = "Saving...",
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

    const modalLock = useModalLock(loading, onClose);

    return (
        <Modal
            opened={opened}
            title={title}
            centered
            radius="lg"
            overlayProps={{ blur: 6 }}
            styles={{ title: MODAL_TITLE_STYLE }}
            // Mantine ships the close button with no accessible name.
            closeButtonProps={{ "aria-label": "Close", style: MODAL_CLOSE_BUTTON_STYLE }}
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
                        label="Name"
                        placeholder="e.g. Hardware Unboxed"
                        value={channelName}
                        onChange={(event) => onChangeChannelName(event.currentTarget.value)}
                        required
                        disabled={loading}
                        autoFocus
                    />

                    {/* The description names one shape where the parser takes handles,
                        channel/, c/ and user/ paths and full URLs. Listing all of them made
                        the field look like it wanted a particular one. Nothing about what it
                        accepts changed. */}
                    <TextInput
                        label="YouTube handle"
                        placeholder="@Hardwareunboxed"
                        value={youtubeHandle}
                        onChange={(event) => onChangeYoutubeHandle(event.currentTarget.value)}
                        description="Enter a YouTube handle or channel URL."
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
                                onChange={(value) =>
                                    onChangeAvatarMode?.(
                                        toUnionValue(
                                            value,
                                            ["none", "manual", "youtube"] as const,
                                            "none"
                                        )
                                    )
                                }
                                data={[
                                    { label: "No avatar", value: "none" },
                                    { label: "Upload file", value: "manual" },
                                    { label: "YouTube avatar", value: "youtube" },
                                ]}
                                disabled={loading}
                            />

                            {/* Both branches carry the same mt rather than the Stack
                                carrying a bigger gap, since the gap would also push the
                                Channel avatar label away from the control. */}
                            {avatarMode === "manual" && (
                                // A read-only TextInput read as a field you could type a
                                // path into, and it spent a full input's height on a value
                                // only the picker can set. Status text and the picker share
                                // a row instead. Clear is rendered only when there is
                                // something to clear, where it used to sit there disabled.
                                <Stack gap={4} mt={4}>
                                    <Text fw={700} size="sm">
                                        Avatar file
                                    </Text>

                                    <Group
                                        justify="space-between"
                                        wrap="nowrap"
                                        align="center"
                                        gap="sm"
                                    >
                                        {/* The name, not the path. A full path wrapped over
                                            three lines for a value the user already knows,
                                            and the whole thing is still readable on hover
                                            for the case where two files share a name. */}
                                        <Tooltip
                                            label={avatarPath}
                                            disabled={!avatarPath.trim()}
                                            withArrow
                                            multiline
                                            w={320}
                                        >
                                            <Text
                                                size="sm"
                                                truncate
                                                c={
                                                    avatarPath.trim()
                                                        ? undefined
                                                        : "dimmed"
                                                }
                                                style={{ minWidth: 0 }}
                                            >
                                                {fileNameFromPath(avatarPath) ||
                                                    "No file selected"}
                                            </Text>
                                        </Tooltip>

                                        <Group
                                            gap="xs"
                                            wrap="nowrap"
                                            style={{ flexShrink: 0 }}
                                        >
                                            <Button
                                                type="button"
                                                variant="light"
                                                onClick={onPickAvatar}
                                                disabled={loading}
                                            >
                                                Choose file
                                            </Button>

                                            {!!avatarPath.trim() && (
                                                <Button
                                                    type="button"
                                                    variant="subtle"
                                                    color="gray"
                                                    leftSection={<X size={14} />}
                                                    onClick={onClearAvatar}
                                                    disabled={loading}
                                                    styles={CLEAR_BUTTON_STYLES}
                                                >
                                                    Clear
                                                </Button>
                                            )}
                                        </Group>
                                    </Group>
                                </Stack>
                            )}

                            {avatarMode === "youtube" && (
                                <Text size="sm" c="dimmed" mt={4}>
                                    Downloads the channel avatar from YouTube using yt-dlp.
                                </Text>
                            )}
                        </Stack>
                    )}

                    <Group justify="flex-end">
                        {/* Bordered rather than subtle, and the same AppButton family as the
                            submit beside it, so the pair reads as two halves of one decision
                            instead of a control next to some text. */}
                        <AppButton
                            type="button"
                            appVariant="secondary"
                            onClick={onClose}
                            disabled={loading}
                        >
                            Cancel
                        </AppButton>

                        {/* The app's primary, like every other CTA. It was the one
                            violet-to-cyan gradient left in the interface. */}
                        <AppButton
                            type="submit"
                            appVariant="primary"
                            disabled={!canSubmit}
                        >
                            {loading ? submitLoadingLabel : submitLabel}
                        </AppButton>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}