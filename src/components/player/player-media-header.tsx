import { ActionIcon, Badge, Box, Button, Group, Stack, Text } from "@mantine/core";
import {
    ArrowLeft,
    CheckCircle2,
    ExternalLink,
    Eye,
    FolderOpen,
    MessageSquareMore,
    Radio,
    RotateCcw,
} from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";

type PlayerMediaHeaderProps = {
    title: string;
    publishedLabel: string;
    createdLabel: string;
    shellBorder: string;
    canOpenInYoutube: boolean;
    isWatched: boolean;
    isLive?: boolean;
    hasLiveChat?: boolean;
    isRefreshingComments?: boolean;
    onOpenInYoutube: () => void | Promise<void>;
    onOpenFileLocation?: () => void | Promise<void>;
    onRefreshComments?: () => void | Promise<void>;
    onMarkWatched: () => void | Promise<void>;
    onMarkUnwatched: () => void | Promise<void>;
    onBack: () => void;
};

export function PlayerMediaHeader({
    title,
    publishedLabel,
    createdLabel,
    shellBorder,
    canOpenInYoutube,
    isWatched,
    isLive = false,
    hasLiveChat = false,
    isRefreshingComments = false,
    onOpenInYoutube,
    onOpenFileLocation,
    onRefreshComments,
    onMarkWatched,
    onMarkUnwatched,
    onBack,
}: PlayerMediaHeaderProps): JSX.Element {
    return (
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                <ActionIcon
                    variant="subtle"
                    size="lg"
                    aria-label="Back to library"
                    onClick={onBack}
                    style={{
                        background: "rgba(255,255,255,0.04)",
                        border: `1px solid ${shellBorder}`,
                        flex: "0 0 auto",
                    }}
                >
                    <ArrowLeft size={18} />
                </ActionIcon>

                <Stack gap={6} style={{ minWidth: 0, flex: 1 }}>
                    <Group gap="xs" wrap="wrap">
                        <Text fw={900} size="lg" lineClamp={1}>
                            {title}
                        </Text>

                        {isWatched && (
                            <Badge
                                variant="light"
                                color="green"
                                leftSection={<CheckCircle2 size={12} />}
                            >
                                {UI_TEXT.library.watchedBadge}
                            </Badge>
                        )}

                        {isLive && (
                            <Badge
                                variant="light"
                                color="red"
                                leftSection={<Radio size={12} />}
                            >
                                LIVE
                            </Badge>
                        )}

                        {hasLiveChat && (
                            <Badge
                                variant="light"
                                color="red"
                            >
                                CHAT REPLAY
                            </Badge>
                        )}
                    </Group>

                    <Box>
                        <Text size="sm" c="dimmed" lineClamp={1}>
                            Published: {publishedLabel || UI_TEXT.library.noPublicationDate}
                        </Text>

                        <Text size="sm" c="dimmed" lineClamp={1}>
                            Added to Kavynex: {createdLabel || "Unknown date"}
                        </Text>
                    </Box>
                </Stack>
            </Group>

            <Group gap="xs" wrap="wrap" justify="flex-end">
                {onOpenFileLocation && (
                    <Button
                        variant="light"
                        color="gray"
                        leftSection={<FolderOpen size={16} />}
                        onClick={() => void onOpenFileLocation()}
                    >
                        Open file location
                    </Button>
                )}

                {onRefreshComments && (
                    <Button
                        variant="light"
                        color="violet"
                        leftSection={<MessageSquareMore size={16} />}
                        onClick={() => void onRefreshComments()}
                        loading={isRefreshingComments}
                    >
                        Refresh comments
                    </Button>
                )}

                {isWatched ? (
                    <Button
                        variant="light"
                        color="gray"
                        leftSection={<RotateCcw size={16} />}
                        onClick={() => void onMarkUnwatched()}
                    >
                        Mark as unwatched
                    </Button>
                ) : (
                    <Button
                        variant="light"
                        color="green"
                        leftSection={<Eye size={16} />}
                        onClick={() => void onMarkWatched()}
                    >
                        Mark as watched
                    </Button>
                )}

                {canOpenInYoutube && (
                    <Button
                        variant="light"
                        leftSection={<ExternalLink size={16} />}
                        onClick={() => void onOpenInYoutube()}
                    >
                        Open source on YouTube
                    </Button>
                )}
            </Group>
        </Group>
    );
}