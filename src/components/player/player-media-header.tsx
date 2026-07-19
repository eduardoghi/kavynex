import type { Ref } from "react";
import { ActionIcon, Badge, Box, Button, Group, Kbd, Popover, Stack, Text } from "@mantine/core";
import {
    ArrowLeft,
    CheckCircle2,
    ExternalLink,
    Eye,
    FolderOpen,
    Keyboard,
    MessageSquareMore,
    Radio,
    RotateCcw,
    X,
} from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";

type PlayerMediaHeaderProps = {
    title: string;
    publishedLabel: string;
    createdLabel: string;
    shellBorder: string;
    canOpenInYoutube: boolean;
    isWatched: boolean;
    isAudio?: boolean;
    // Required rather than defaulting to false: as optional props they silently defaulted their
    // badges out of existence when the only caller forgot to pass them, and nothing failed. The
    // compiler is the only thing that catches that.
    isLive: boolean;
    hasLiveChat: boolean;
    isRefreshingComments?: boolean;
    onOpenInYoutube: () => void | Promise<void>;
    onOpenFileLocation?: () => void | Promise<void>;
    onRefreshComments?: () => void | Promise<void>;
    onCancelRefreshComments?: () => void | Promise<void>;
    onMarkWatched: () => void | Promise<void>;
    onMarkUnwatched: () => void | Promise<void>;
    onBack: () => void;
    // Focused when the player opens so keyboard/screen-reader users land on the player instead of
    // being dropped on <body> (the library section stays mounted but hidden behind it).
    backButtonRef?: Ref<HTMLButtonElement>;
};

type KeyboardShortcut = {
    keys: string[];
    label: string;
    videoOnly?: boolean;
};

const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
    { keys: ["Space"], label: "Play / Pause" },
    { keys: ["←"], label: "Seek back 5s" },
    { keys: ["→"], label: "Seek forward 5s" },
    { keys: ["M"], label: "Mute / Unmute" },
    { keys: ["F"], label: "Fullscreen", videoOnly: true },
];

export function PlayerMediaHeader({
    title,
    publishedLabel,
    createdLabel,
    shellBorder,
    canOpenInYoutube,
    isWatched,
    isAudio = false,
    isLive,
    hasLiveChat,
    isRefreshingComments = false,
    onOpenInYoutube,
    onOpenFileLocation,
    onRefreshComments,
    onCancelRefreshComments,
    onMarkWatched,
    onMarkUnwatched,
    onBack,
    backButtonRef,
}: PlayerMediaHeaderProps): JSX.Element {
    return (
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                <ActionIcon
                    ref={backButtonRef}
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
                <Popover position="bottom-end" withArrow shadow="md" width={260}>
                    <Popover.Target>
                        <ActionIcon
                            variant="subtle"
                            size="lg"
                            aria-label="Keyboard shortcuts"
                            style={{
                                background: "rgba(255,255,255,0.04)",
                                border: `1px solid ${shellBorder}`,
                            }}
                        >
                            <Keyboard size={16} />
                        </ActionIcon>
                    </Popover.Target>

                    <Popover.Dropdown>
                        <Stack gap="xs">
                            <Text fw={700} size="sm">
                                Keyboard shortcuts
                            </Text>

                            {KEYBOARD_SHORTCUTS.filter(
                                (shortcut) => !shortcut.videoOnly || !isAudio
                            ).map((shortcut) => (
                                <Group key={shortcut.label} justify="space-between" wrap="nowrap">
                                    <Text size="sm" c="dimmed">
                                        {shortcut.label}
                                    </Text>

                                    <Group gap={4} wrap="nowrap">
                                        {shortcut.keys.map((key) => (
                                            <Kbd key={key} size="sm">
                                                {key}
                                            </Kbd>
                                        ))}
                                    </Group>
                                </Group>
                            ))}
                        </Stack>
                    </Popover.Dropdown>
                </Popover>

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

                {/* A comment backup can run for minutes; while one is in flight, offer an explicit
                    Cancel that stops the yt-dlp process on the backend instead of only waiting it
                    out. Shown alongside the (loading) Refresh button, not in place of it. */}
                {onCancelRefreshComments && isRefreshingComments && (
                    <Button
                        variant="light"
                        color="red"
                        leftSection={<X size={16} />}
                        onClick={() => void onCancelRefreshComments()}
                    >
                        Cancel
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