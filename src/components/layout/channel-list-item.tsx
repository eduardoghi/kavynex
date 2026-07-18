import { ActionIcon, Avatar, Group, Loader, Menu, Stack, Text } from "@mantine/core";
import { ImagePlus, MoreVertical, Pencil, RefreshCw, Trash2, UserX } from "lucide-react";
import { memo, type CSSProperties } from "react";
import { StretchedButtonCard } from "../common/stretched-button-card";
import type { Channel, ViewMode } from "../../types/media";
import { fileSrcFromStoredPath, initials } from "../../utils/media-utils";

// Style objects that never depend on props or state, hoisted to module scope so they are
// allocated once rather than rebuilt on every render. The row's own dynamic styles (the card
// background/border keyed on selected/isBusy, the avatar border keyed on shellBorder) stay inline
// because they read runtime values.
const ROW_MENU_STYLES = {
    dropdown: {
        borderRadius: 14,
        padding: 6,
        background: "rgba(36, 36, 40, 0.98)",
        border: "1px solid rgba(255,255,255,0.08)",
        backdropFilter: "blur(12px)",
    },
    item: {
        borderRadius: 10,
        paddingBlock: 10,
        paddingInline: 12,
    },
    divider: {
        marginBlock: 6,
    },
} satisfies Record<string, CSSProperties>;

// Above the stretched select overlay so the menu stays clickable while the rest of the row
// selects the channel.
const ROW_ACTION_ICON_STYLE: CSSProperties = {
    position: "relative",
    zIndex: 2,
};

type ChannelListItemProps = {
    channel: Channel;
    selected: boolean;
    isDeleting: boolean;
    isUpdatingAvatar: boolean;
    viewMode: ViewMode;
    shellBorder: string;
    libraryPath: string;
    onSelectChannel: (channelId: number) => void;
    onRequestEditChannel: (channel: Channel) => void;
    onRequestDeleteChannel: (channel: Channel) => void;
    onUpdateChannelAvatarFromFile: (channel: Channel) => void | Promise<void>;
    onUpdateChannelAvatarFromYouTube: (channel: Channel) => void | Promise<void>;
    onRemoveChannelAvatar: (channel: Channel) => void | Promise<void>;
    onClosePlayer: () => void;
};

// Memoized so a single channel row only re-renders when its own props change. Without this,
// every re-render of the parent (e.g. player state churn during playback) re-diffs every row's
// Paper/Avatar/Menu. All props are primitives or references expected to be stable across
// renders, so an unrelated re-render skips untouched rows entirely.
export const ChannelListItem = memo(function ChannelListItem({
    channel,
    selected,
    isDeleting,
    isUpdatingAvatar,
    viewMode,
    shellBorder,
    libraryPath,
    onSelectChannel,
    onRequestEditChannel,
    onRequestDeleteChannel,
    onUpdateChannelAvatarFromFile,
    onUpdateChannelAvatarFromYouTube,
    onRemoveChannelAvatar,
    onClosePlayer,
}: ChannelListItemProps): JSX.Element {
    const avatarSrc = fileSrcFromStoredPath(channel.avatar_path, libraryPath);

    const handleSelect = (): void => {
        onSelectChannel(channel.id);

        if (viewMode === "player") {
            onClosePlayer();
        }
    };

    // Busy while an avatar update or delete is in flight, so assistive tech is told the row's
    // content (loader shown in place of the menu) is transiently changing.
    const isBusy = isDeleting || isUpdatingAvatar;

    return (
        <StretchedButtonCard
            ariaLabel={`Open channel ${channel.name}`}
            ariaCurrent={selected}
            ariaBusy={isBusy}
            disabled={isBusy}
            onClick={handleSelect}
            radius="xl"
            p="sm"
            style={{
                cursor: isBusy ? "default" : "pointer",
                borderColor: selected ? "rgba(139,92,246,0.45)" : shellBorder,
                background: selected
                    ? "rgba(124,92,255,0.10)"
                    : "rgba(255,255,255,0.025)",
                opacity: isBusy ? 0.6 : 1,
                transition: "background 160ms ease, border-color 160ms ease",
            }}
        >
            <Group wrap="nowrap" gap="sm">
                <Avatar
                    radius="xl"
                    size={44}
                    src={avatarSrc || undefined}
                    styles={{
                        root: {
                            background:
                                "linear-gradient(135deg, rgba(168,85,247,0.32), rgba(59,130,246,0.20))",
                            border: `1px solid ${shellBorder}`,
                        },
                    }}
                >
                    {!avatarSrc ? initials(channel.name) : null}
                </Avatar>

                <Stack gap={1} style={{ flex: 1, minWidth: 0 }}>
                    <Text fw={900} truncate>
                        {channel.name}
                    </Text>

                    <Text size="xs" c="dimmed" truncate>
                        {channel.youtube_handle}
                    </Text>
                </Stack>

                {isBusy ? (
                    <Loader size="xs" />
                ) : (
                    <Menu
                        withinPortal
                        position="bottom-end"
                        shadow="lg"
                        width={220}
                        offset={8}
                        styles={ROW_MENU_STYLES}
                    >
                        <Menu.Target>
                            <ActionIcon
                                variant="subtle"
                                radius="xl"
                                aria-label={`Actions for ${channel.name}`}
                                style={ROW_ACTION_ICON_STYLE}
                            >
                                <MoreVertical size={18} />
                            </ActionIcon>
                        </Menu.Target>

                        <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
                            <Menu.Item
                                leftSection={<Pencil size={16} />}
                                onClick={() => onRequestEditChannel(channel)}
                            >
                                Edit name / handle
                            </Menu.Item>

                            <Menu.Item
                                leftSection={<ImagePlus size={16} />}
                                onClick={() => {
                                    void onUpdateChannelAvatarFromFile(channel);
                                }}
                            >
                                Choose avatar file
                            </Menu.Item>

                            <Menu.Item
                                leftSection={<RefreshCw size={16} />}
                                onClick={() => {
                                    void onUpdateChannelAvatarFromYouTube(channel);
                                }}
                            >
                                Load avatar from YouTube
                            </Menu.Item>

                            <Menu.Item
                                leftSection={<UserX size={16} />}
                                onClick={() => {
                                    void onRemoveChannelAvatar(channel);
                                }}
                                disabled={!channel.avatar_path}
                            >
                                Remove avatar
                            </Menu.Item>

                            <Menu.Divider />

                            <Menu.Item
                                color="red"
                                leftSection={<Trash2 size={16} />}
                                onClick={() => onRequestDeleteChannel(channel)}
                            >
                                Delete channel
                            </Menu.Item>
                        </Menu.Dropdown>
                    </Menu>
                )}
            </Group>
        </StretchedButtonCard>
    );
});
