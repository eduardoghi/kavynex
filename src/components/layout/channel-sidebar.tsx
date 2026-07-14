import {
    ActionIcon,
    AppShell,
    Avatar,
    Badge,
    Box,
    Card,
    Group,
    Loader,
    Menu,
    ScrollArea,
    Stack,
    Text,
} from "@mantine/core";
import {
    ImagePlus,
    MoreVertical,
    Pencil,
    RefreshCw,
    Trash2,
    UserX,
} from "lucide-react";
import { memo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { StretchedButtonCard } from "../common/stretched-button-card";
import type { Channel, ViewMode } from "../../types/media";
import { fileSrcFromStoredPath, initials } from "../../utils/media-utils";

// Row-height estimate for the virtualized channel list. Each row is a fixed-layout avatar plus
// two truncated text lines, so heights are near-uniform; measureElement corrects any drift.
const CHANNEL_ROW_ESTIMATE = 72;
// Matches the "xs" Stack gap the list used before virtualization, applied as per-row bottom
// padding since absolutely positioned virtual rows do not receive the flex gap.
const CHANNEL_ROW_GAP = 8;

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
const ChannelListItem = memo(function ChannelListItem({
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
                        styles={{
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
                        }}
                    >
                        <Menu.Target>
                            <ActionIcon
                                variant="subtle"
                                radius="xl"
                                aria-label={`Actions for ${channel.name}`}
                                style={{
                                    // Above the stretched select overlay so the menu stays
                                    // clickable while the rest of the row selects the channel.
                                    position: "relative",
                                    zIndex: 2,
                                }}
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

type ChannelSidebarProps = {
    channels: Channel[];
    selectedChannelId: number | null;
    viewMode: ViewMode;
    shellBorder: string;
    shellSurface: string;
    loading?: boolean;
    deletingChannelId?: number | null;
    updatingChannelAvatarId?: number | null;
    libraryPath: string;
    onSelectChannel: (channelId: number) => void;
    onRequestEditChannel: (channel: Channel) => void;
    onRequestDeleteChannel: (channel: Channel) => void;
    onUpdateChannelAvatarFromFile: (channel: Channel) => void | Promise<void>;
    onUpdateChannelAvatarFromYouTube: (channel: Channel) => void | Promise<void>;
    onRemoveChannelAvatar: (channel: Channel) => void | Promise<void>;
    onClosePlayer: () => void;
};

export function ChannelSidebar({
    channels,
    selectedChannelId,
    viewMode,
    shellBorder,
    shellSurface,
    loading = false,
    deletingChannelId = null,
    updatingChannelAvatarId = null,
    libraryPath,
    onSelectChannel,
    onRequestEditChannel,
    onRequestDeleteChannel,
    onUpdateChannelAvatarFromFile,
    onUpdateChannelAvatarFromYouTube,
    onRemoveChannelAvatar,
    onClosePlayer,
}: ChannelSidebarProps): JSX.Element {
    const scrollViewportRef = useRef<HTMLDivElement>(null);

    // Virtualize the channel rows so a library with a very large number of channels only mounts
    // the visible rows. Rows are near-uniform height (estimateSize), corrected by measureElement.
    const rowVirtualizer = useVirtualizer({
        count: channels.length,
        getScrollElement: () => scrollViewportRef.current,
        estimateSize: () => CHANNEL_ROW_ESTIMATE + CHANNEL_ROW_GAP,
        overscan: 6,
    });

    const virtualRows = rowVirtualizer.getVirtualItems();

    return (
        <AppShell.Navbar
            p="md"
            style={{
                background: "rgba(9, 13, 22, 0.72)",
                borderRight: `1px solid ${shellBorder}`,
                backdropFilter: "blur(18px)",
            }}
        >
            <Stack gap="sm" h="100%">
                <Group justify="space-between" px={2} mb="xs">
                    <Box>
                        <Text fw={900} size="sm">
                            Channels
                        </Text>
                        <Text size="xs" c="dimmed">
                            Your collections
                        </Text>
                    </Box>

                    <Badge
                        variant="light"
                        color="gray"
                        radius="xl"
                        size="lg"
                        styles={{
                            root: {
                                minWidth: 30,
                                justifyContent: "center",
                                paddingInline: 10,
                            },
                            label: {
                                fontWeight: 800,
                                fontSize: 12,
                                lineHeight: 1,
                            },
                        }}
                    >
                        {loading ? "..." : channels.length}
                    </Badge>
                </Group>

                <ScrollArea
                    viewportRef={scrollViewportRef}
                    style={{ flex: 1 }}
                    offsetScrollbars
                >
                    <Stack gap="xs">
                        {loading && (
                            <Card
                                withBorder
                                p="md"
                                style={{
                                    borderColor: shellBorder,
                                    background: shellSurface,
                                }}
                            >
                                <Group gap="sm" justify="center">
                                    <Loader size="sm" />
                                    <Text c="dimmed" size="sm">
                                        Loading channels...
                                    </Text>
                                </Group>
                            </Card>
                        )}

                        {!loading && channels.length === 0 && (
                            <Card
                                withBorder
                                p="md"
                                style={{
                                    borderColor: shellBorder,
                                    background: "rgba(255,255,255,0.03)",
                                }}
                            >
                                <Text fw={900}>No channels yet</Text>

                                <Text c="dimmed" size="sm" mt={4}>
                                    Use <b>New channel</b> in the top bar to create your first one.
                                </Text>
                            </Card>
                        )}

                        {!loading && channels.length > 0 && (
                            <Box
                                style={{
                                    height: `${rowVirtualizer.getTotalSize()}px`,
                                    width: "100%",
                                    position: "relative",
                                }}
                            >
                                {virtualRows.map((virtualRow) => {
                                    const channel = channels[virtualRow.index];

                                    // The virtualizer only yields in-range indices, so this is
                                    // never null in practice; the guard satisfies the checked-index
                                    // type and renders nothing rather than crashing if it ever were.
                                    if (!channel) {
                                        return null;
                                    }

                                    return (
                                        <Box
                                            key={channel.id}
                                            ref={rowVirtualizer.measureElement}
                                            data-index={virtualRow.index}
                                            style={{
                                                position: "absolute",
                                                top: 0,
                                                left: 0,
                                                width: "100%",
                                                transform: `translateY(${virtualRow.start}px)`,
                                                paddingBottom: CHANNEL_ROW_GAP,
                                            }}
                                        >
                                            <ChannelListItem
                                                channel={channel}
                                                selected={channel.id === selectedChannelId}
                                                isDeleting={channel.id === deletingChannelId}
                                                isUpdatingAvatar={
                                                    channel.id === updatingChannelAvatarId
                                                }
                                                viewMode={viewMode}
                                                shellBorder={shellBorder}
                                                libraryPath={libraryPath}
                                                onSelectChannel={onSelectChannel}
                                                onRequestEditChannel={onRequestEditChannel}
                                                onRequestDeleteChannel={onRequestDeleteChannel}
                                                onUpdateChannelAvatarFromFile={
                                                    onUpdateChannelAvatarFromFile
                                                }
                                                onUpdateChannelAvatarFromYouTube={
                                                    onUpdateChannelAvatarFromYouTube
                                                }
                                                onRemoveChannelAvatar={onRemoveChannelAvatar}
                                                onClosePlayer={onClosePlayer}
                                            />
                                        </Box>
                                    );
                                })}
                            </Box>
                        )}
                    </Stack>
                </ScrollArea>
            </Stack>
        </AppShell.Navbar>
    );
}