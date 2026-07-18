import {
    AppShell,
    Badge,
    Box,
    Card,
    Group,
    Loader,
    ScrollArea,
    Stack,
    Text,
} from "@mantine/core";
import { useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChannelListItem } from "./channel-list-item";
import type { Channel, ViewMode } from "../../types/media";

// Row-height estimate for the virtualized channel list. Each row is a fixed-layout avatar plus
// two truncated text lines, so heights are near-uniform; measureElement corrects any drift.
const CHANNEL_ROW_ESTIMATE = 72;
// Matches the "xs" Stack gap the list used before virtualization, applied as per-row bottom
// padding since absolutely positioned virtual rows do not receive the flex gap.
const CHANNEL_ROW_GAP = 8;

const COUNT_BADGE_STYLES = {
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
} satisfies Record<string, CSSProperties>;

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
                        styles={COUNT_BADGE_STYLES}
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