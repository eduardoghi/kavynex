import { type CSSProperties } from "react";
import { ActionIcon, Menu } from "@mantine/core";
import {
    ExternalLink,
    Eye,
    FolderOpen,
    MoreVertical,
    Pencil,
    RotateCcw,
    Trash2,
} from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaRow } from "../../types/media";

// The per-card actions menu. Split out of `media-card.tsx` because it is where that component grows:
// every action added to a card lands here, and it already carried six of them plus the four
// conditions that decide which are shown. Keeping it beside the card rather than in a subdirectory
// matches how `media-grid-skeleton.tsx` already sits beside `media-grid.tsx`.
//
// Every callback is optional and an absent one hides its item rather than disabling it, which is the
// existing contract: Home passes the handlers it has, and a card rendered somewhere with fewer of
// them shows a shorter menu instead of dead entries.

// Above the stretched open-button overlay so the menu stays clickable while the rest of the card
// opens the media.
const MENU_ACTION_ICON_STYLE: CSSProperties = {
    position: "relative",
    zIndex: 2,
    flexShrink: 0,
};

type MediaCardActionsMenuProps = {
    media: MediaRow;
    isWatched: boolean;
    // True while this card's own watched/unwatched toggle is in flight (see
    // MediaLibraryController.watchedActionInFlight), so the action disables instead of silently
    // doing nothing on a second click while the first is still running.
    isWatchedActionInFlight: boolean;
    onRequestDelete: (media: MediaRow) => void;
    onOpenFileLocation?: (media: MediaRow) => void;
    onOpenSourceInYoutube?: (media: MediaRow) => void;
    onMarkWatched?: (media: MediaRow) => void;
    onMarkUnwatched?: (media: MediaRow) => void;
    onEditTitle?: (media: MediaRow) => void;
};

export function MediaCardActionsMenu({
    media,
    isWatched,
    isWatchedActionInFlight,
    onRequestDelete,
    onOpenFileLocation,
    onOpenSourceInYoutube,
    onMarkWatched,
    onMarkUnwatched,
    onEditTitle,
}: MediaCardActionsMenuProps): JSX.Element {
    const hasYoutubeSource = Boolean(media.youtube_video_id?.trim());

    return (
        <Menu withinPortal position="bottom-end" shadow="md">
            <Menu.Target>
                <ActionIcon
                    variant="subtle"
                    aria-label={`Actions for ${media.title}`}
                    style={MENU_ACTION_ICON_STYLE}
                >
                    <MoreVertical size={18} />
                </ActionIcon>
            </Menu.Target>

            {/* The card is a stretched button, so a click anywhere on it opens the media. Stopping
                propagation here is what keeps choosing a menu item from also opening it. */}
            <Menu.Dropdown onClick={(event) => event.stopPropagation()}>
                {onOpenFileLocation && (
                    <Menu.Item
                        leftSection={<FolderOpen size={16} />}
                        onClick={() => onOpenFileLocation(media)}
                    >
                        Open file location
                    </Menu.Item>
                )}

                {hasYoutubeSource && onOpenSourceInYoutube && (
                    <Menu.Item
                        leftSection={<ExternalLink size={16} />}
                        onClick={() => onOpenSourceInYoutube(media)}
                    >
                        Open source on YouTube
                    </Menu.Item>
                )}

                {onEditTitle && (
                    <Menu.Item
                        leftSection={<Pencil size={16} />}
                        onClick={() => onEditTitle(media)}
                    >
                        Edit title
                    </Menu.Item>
                )}

                {!isWatched && onMarkWatched && (
                    <Menu.Item
                        leftSection={<Eye size={16} />}
                        onClick={() => onMarkWatched(media)}
                        disabled={isWatchedActionInFlight}
                    >
                        Mark as watched
                    </Menu.Item>
                )}

                {isWatched && onMarkUnwatched && (
                    <Menu.Item
                        leftSection={<RotateCcw size={16} />}
                        onClick={() => onMarkUnwatched(media)}
                        disabled={isWatchedActionInFlight}
                    >
                        Mark as unwatched
                    </Menu.Item>
                )}

                <Menu.Item
                    color="red"
                    leftSection={<Trash2 size={16} />}
                    onClick={() => onRequestDelete(media)}
                >
                    {UI_TEXT.library.delete}
                </Menu.Item>
            </Menu.Dropdown>
        </Menu>
    );
}
