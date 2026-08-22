import type { CSSProperties, Ref } from "react";
import {
    ActionIcon,
    Badge,
    Button,
    Group,
    Kbd,
    Loader,
    Menu,
    Popover,
    Stack,
    Text,
    Tooltip,
} from "@mantine/core";
import {
    ArrowLeft,
    CheckCircle2,
    ExternalLink,
    Eye,
    FolderOpen,
    Keyboard,
    MessageSquareMore,
    MoreHorizontal,
    Radio,
    RotateCcw,
    X,
} from "lucide-react";
import { LIVE_BADGE_STYLE } from "../../constants/live-badge";
import { UI_TEXT } from "../../constants/ui-text";

type PlayerMediaHeaderProps = {
    title: string;
    publishedLabel: string;
    createdLabel: string;
    shellBorder: string;
    canOpenInYoutube: boolean;
    isWatched: boolean;
    isAudio?: boolean;
    // Required rather than defaulting to false. As an optional prop it silently defaulted its badge
    // out of existence when the only caller forgot to pass it, and nothing failed. The compiler is
    // the only thing that catches that.
    isLive: boolean;
    isRefreshingComments?: boolean;
    // True while this media's own watched/unwatched toggle is in flight. Mirrors
    // isRefreshingComments so the button below shows the same loading feedback pattern as the
    // Refresh comments item.
    isUpdatingWatchedStatus?: boolean;
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
    { keys: ["↑"], label: "Volume up" },
    { keys: ["↓"], label: "Volume down" },
    { keys: ["M"], label: "Mute / Unmute" },
    { keys: ["F"], label: "Fullscreen", videoOnly: true },
];

// Every control in the header is this tall. Mantine's named ActionIcon sizes stop at 34px
// while a default Button is 36, so the icon buttons take the number instead of "lg". That is
// what stops the row stepping up and down by two pixels. Radius is left to the theme, which
// already puts xl on both Button and ActionIcon.
const HEADER_CONTROL_HEIGHT = 36;

// Subtle controls hover into the theme violet, loud enough next to Mark as watched to read as
// a second primary. A neutral wash at low opacity keeps the affordance without the shout. Only
// the hover colour is overridden, so no padding or geometry moves between states.
const NEUTRAL_CONTROL_HOVER = "light-dark(rgba(0,0,0,0.055), rgba(255,255,255,0.06))";

export function PlayerMediaHeader({
    title,
    publishedLabel,
    createdLabel,
    shellBorder,
    canOpenInYoutube,
    isWatched,
    isAudio = false,
    isLive,
    isRefreshingComments = false,
    isUpdatingWatchedStatus = false,
    onOpenInYoutube,
    onOpenFileLocation,
    onRefreshComments,
    onCancelRefreshComments,
    onMarkWatched,
    onMarkUnwatched,
    onBack,
    backButtonRef,
}: PlayerMediaHeaderProps): JSX.Element {
    // Back, Keyboard shortcuts and the overflow menu are the same icon-button shell. It reads off
    // shellBorder, so it belongs here rather than in a module constant.
    const iconButtonStyle = {
        background: "light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.04))",
        border: `1px solid ${shellBorder}`,
        "--ai-hover": NEUTRAL_CONTROL_HOVER,
    } as CSSProperties;

    const hasOverflowActions = Boolean(onOpenFileLocation || onRefreshComments);

    return (
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="md">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                <ActionIcon
                    ref={backButtonRef}
                    variant="subtle"
                    size={HEADER_CONTROL_HEIGHT}
                    aria-label="Back to library"
                    onClick={onBack}
                    style={{ ...iconButtonStyle, flex: "0 0 auto" }}
                >
                    <ArrowLeft size={18} />
                </ActionIcon>

                <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
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
                                variant="filled"
                                style={LIVE_BADGE_STYLE}
                                leftSection={<Radio size={12} />}
                            >
                                LIVE
                            </Badge>
                        )}
                    </Group>

                    {/* Both dates on one line, reading as a single metadata strip under the title
                        rather than two stacked sentences competing with it. The separator is hidden
                        from assistive tech, which would otherwise announce the dot. */}
                    <Group gap={8} wrap="wrap">
                        <Text size="sm" c="dimmed" lineClamp={1}>
                            Published: {publishedLabel || UI_TEXT.library.noPublicationDate}
                        </Text>

                        <Text size="sm" c="dimmed" aria-hidden>
                            ·
                        </Text>

                        <Text size="sm" c="dimmed" lineClamp={1}>
                            Added to Kavynex: {createdLabel || "Unknown date"}
                        </Text>
                    </Group>
                </Stack>
            </Group>

            <Group gap="xs" wrap="wrap" justify="flex-end" align="center">
                {/* Icon only. The lucide version pinned here ships no YouTube glyph, and a
                    brand icon pack is not worth pulling in for one button. The external-link
                    arrow is the honest symbol anyway, since the action opens a page in the
                    browser rather than playing anything. The tooltip and the aria-label carry
                    the wording the visible label used to. */}
                {canOpenInYoutube && (
                    <Tooltip label="Open source on YouTube" withArrow>
                        <ActionIcon
                            variant="subtle"
                            size={HEADER_CONTROL_HEIGHT}
                            aria-label="Open source on YouTube"
                            onClick={() => void onOpenInYoutube()}
                            style={iconButtonStyle}
                        >
                            <ExternalLink size={16} />
                        </ActionIcon>
                    </Tooltip>
                )}

                <Popover position="bottom-end" withArrow shadow="md" width={260}>
                    <Popover.Target>
                        <ActionIcon
                            variant="subtle"
                            size={HEADER_CONTROL_HEIGHT}
                            aria-label="Keyboard shortcuts"
                            style={iconButtonStyle}
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


                {/* Open file location and Refresh comments sit behind the overflow. Neither is
                    reached often enough to spend a full button on, and as buttons they gave the
                    header five controls of identical weight with nothing saying which one the page
                    is actually for. */}
                {hasOverflowActions && (
                    <Menu position="bottom-end" withArrow shadow="md" width={230}>
                        <Menu.Target>
                            <ActionIcon
                                variant="subtle"
                                size={HEADER_CONTROL_HEIGHT}
                                aria-label="More actions"
                                style={iconButtonStyle}
                            >
                                <MoreHorizontal size={16} />
                            </ActionIcon>
                        </Menu.Target>

                        <Menu.Dropdown>
                            {onOpenFileLocation && (
                                <Menu.Item
                                    leftSection={<FolderOpen size={16} />}
                                    onClick={() => void onOpenFileLocation()}
                                >
                                    Open file location
                                </Menu.Item>
                            )}

                            {onRefreshComments && (
                                <Menu.Item
                                    leftSection={
                                        isRefreshingComments ? (
                                            <Loader size={14} />
                                        ) : (
                                            <MessageSquareMore size={16} />
                                        )
                                    }
                                    onClick={() => void onRefreshComments()}
                                    disabled={isRefreshingComments}
                                >
                                    Refresh comments
                                </Menu.Item>
                            )}
                        </Menu.Dropdown>
                    </Menu>
                )}

                {/* A comment backup can run for minutes, so while one is in flight offer an explicit
                    Cancel that stops the yt-dlp process on the backend instead of only waiting it
                    out. It stays outside the overflow because burying the stop for a running
                    operation behind a menu is the one place the extra click costs something, and it
                    exists only while that operation is running. */}
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

                {/* The primary action, and the only filled control on the page. Marking a media
                    watched is what the user came here to finish, so it holds the rightmost slot at
                    full weight. Undoing it is not the same kind of action and stays light. */}
                {isWatched ? (
                    <Button
                        variant="light"
                        color="gray"
                        leftSection={<RotateCcw size={16} />}
                        onClick={() => void onMarkUnwatched()}
                        loading={isUpdatingWatchedStatus}
                    >
                        Mark as unwatched
                    </Button>
                ) : (
                    <Button
                        variant="filled"
                        color="green"
                        leftSection={<Eye size={16} />}
                        onClick={() => void onMarkWatched()}
                        loading={isUpdatingWatchedStatus}
                    >
                        Mark as watched
                    </Button>
                )}
            </Group>
        </Group>
    );
}
