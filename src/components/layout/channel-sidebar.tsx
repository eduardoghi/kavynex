import {
    ActionIcon,
    AppShell,
    Box,
    Card,
    Group,
    ScrollArea,
    Skeleton,
    Stack,
    Text,
    Tooltip,
    VisuallyHidden,
} from "@mantine/core";
import { Plus, Settings } from "lucide-react";
import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChannelListItem } from "./channel-list-item";
import { ThemeToggle } from "./theme-toggle";
import { useAppVersion } from "../../hooks/use-app-version";
import { DISPLAY_FONT_FAMILY } from "../../constants/fonts";
import type { Channel, ViewMode } from "../../types/media";

// Row-height estimate for the virtualized channel list. Each row is a fixed-layout avatar plus
// two truncated text lines, so heights are near-uniform; measureElement corrects any drift.
const CHANNEL_ROW_ESTIMATE = 72;
// Matches the "xs" Stack gap the list used before virtualization, applied as per-row bottom
// padding since absolutely positioned virtual rows do not receive the flex gap.
const CHANNEL_ROW_GAP = 8;

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
    // Branding and the app-level actions the sidebar now hosts (the top bar was removed). Optional so
    // the component still renders bare in isolation tests; the app always supplies them.
    appIconSrc?: string;
    onOpenCreateChannel?: () => void;
    onOpenSettings?: () => void;
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
    appIconSrc,
    onOpenCreateChannel,
    onOpenSettings,
    onSelectChannel,
    onRequestEditChannel,
    onRequestDeleteChannel,
    onUpdateChannelAvatarFromFile,
    onUpdateChannelAvatarFromYouTube,
    onRemoveChannelAvatar,
    onClosePlayer,
}: ChannelSidebarProps): JSX.Element {
    const scrollViewportRef = useRef<HTMLDivElement>(null);
    const appVersion = useAppVersion();

    // Virtualize the channel rows so a library with a very large number of channels only mounts
    // the visible rows. Rows are near-uniform height (estimateSize), corrected by measureElement.
    const rowVirtualizer = useVirtualizer({
        count: channels.length,
        getScrollElement: () => scrollViewportRef.current,
        estimateSize: () => CHANNEL_ROW_ESTIMATE + CHANNEL_ROW_GAP,
        // Key by channel id, not by position. The rows below take `measureElement` and are keyed to
        // React by `channel.id`, so leaving this at the default index key indexes the measurement
        // cache by position while React reconciles by identity: renaming, adding or deleting a
        // channel reorders the list and a row inherits the height measured for a different channel.
        getItemKey: (index) => channels[index]?.id ?? index,
        overscan: 6,
    });

    const virtualRows = rowVirtualizer.getVirtualItems();

    return (
        <AppShell.Navbar
            p="lg"
            style={{
                background: "light-dark(rgba(255, 255, 255, 0.82), rgba(15, 11, 19, 0.72))",
                borderRight: `1px solid ${shellBorder}`,
                backdropFilter: "blur(18px)",
            }}
        >
            <Stack gap="sm" h="100%">
                <Group justify="space-between" px={2} wrap="nowrap">
                    <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                        {appIconSrc ? (
                            <img
                                src={appIconSrc}
                                width={32}
                                height={32}
                                alt="Kavynex"
                                style={{ borderRadius: 8, display: "block" }}
                            />
                        ) : null}

                        <Group gap={8} align="baseline" wrap="nowrap">
                            <Text
                                fw={700}
                                size="xl"
                                lh={1}
                                style={{
                                    fontFamily: DISPLAY_FONT_FAMILY,
                                    letterSpacing: "-0.01em",
                                }}
                            >
                                Kavynex
                            </Text>

                            {appVersion ? (
                                <Text c="dimmed" size="xs" lh={1}>
                                    v{appVersion}
                                </Text>
                            ) : null}
                        </Group>
                    </Group>

                    <Group gap={2} wrap="nowrap" style={{ marginRight: -12 }}>
                        <ThemeToggle />

                        {onOpenCreateChannel ? (
                            <Tooltip label="New channel" withArrow>
                                <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    size="lg"
                                    radius="md"
                                    aria-label="New channel"
                                    onClick={onOpenCreateChannel}
                                >
                                    <Plus size={18} />
                                </ActionIcon>
                            </Tooltip>
                        ) : null}

                        {onOpenSettings ? (
                            <Tooltip label="Settings" withArrow>
                                <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    size="lg"
                                    radius="md"
                                    aria-label="Open settings"
                                    onClick={onOpenSettings}
                                >
                                    <Settings size={18} />
                                </ActionIcon>
                            </Tooltip>
                        ) : null}
                    </Group>
                </Group>

                <Group justify="space-between" align="center" mt="xl" mb="xs">
                    <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.08em" }}>
                        CHANNELS
                    </Text>

                    <Text size="xs" c="dimmed">
                        {loading ? "..." : channels.length}
                    </Text>
                </Group>

                <ScrollArea
                    viewportRef={scrollViewportRef}
                    style={{ flex: 1 }}
                    offsetScrollbars
                >
                    <Stack gap="xs">
                        {loading && (
                            <Box role="status">
                                <VisuallyHidden>Loading channels</VisuallyHidden>
                                <Stack gap="xs" aria-hidden>
                                    {Array.from({ length: 7 }, (_, index) => (
                                        <Group key={index} gap="sm" wrap="nowrap" p={8}>
                                            <Skeleton circle height={44} />
                                            <Stack gap={8} style={{ flex: 1, minWidth: 0 }}>
                                                <Skeleton height={12} width="70%" radius="sm" />
                                                <Skeleton height={10} width="45%" radius="sm" />
                                            </Stack>
                                        </Group>
                                    ))}
                                </Stack>
                            </Box>
                        )}

                        {!loading && channels.length === 0 && (
                            <Card
                                withBorder
                                p="md"
                                style={{
                                    borderColor: shellBorder,
                                    background: shellSurface,
                                }}
                            >
                                <Text fw={900}>No channels yet</Text>

                                <Text c="dimmed" size="sm" mt={4}>
                                    Use the <b>+</b> above to add your first channel.
                                </Text>
                            </Card>
                        )}

                        {!loading && channels.length > 0 && (
                            // Only the rows near the viewport exist in the DOM, so assistive tech
                            // cannot count the channels by walking it. The explicit list role plus
                            // aria-setsize/aria-posinset below restore that: every row announces
                            // "N of <total>" even though the rest is not rendered.
                            <Box
                                role="list"
                                aria-label="Channels"
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
                                            role="listitem"
                                            aria-setsize={channels.length}
                                            aria-posinset={virtualRow.index + 1}
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