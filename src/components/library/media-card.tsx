import { memo, type CSSProperties } from "react";
import { Badge, Box, Group, Stack, Text, Tooltip, rem } from "@mantine/core";
import { Headphones, MessageCircle, Radio, Video } from "lucide-react";
import { LIVE_BADGE_STYLE } from "../../constants/live-badge";
import { StretchedButtonCard } from "../common/stretched-button-card";
import { MediaCardActionsMenu } from "./media-card-actions-menu";
import { MediaCardThumbnail } from "./media-card-thumbnail";
import { MEDIA_TYPE_ACCENT_COLOR } from "../../constants/media-type-accent";
import { UI_TEXT } from "../../constants/ui-text";
import type { MediaRow } from "../../types/media";
import { formatDuration, formatPublishedDate, isMediaWatched } from "../../utils/media-utils";

type MediaCardProps = {
    media: MediaRow;
    libraryPath: string;
    // Absolute path to a display-sized copy of this media's stored thumbnail, when one has been
    // resolved (see hooks/use-display-thumbnails.ts). Passed straight through to the thumbnail,
    // which owns the preference between it and the stored file.
    displayThumbnailPath?: string;
    shellBorder: string;
    isActive?: boolean;
    onOpen: (media: MediaRow) => void;
    onRequestDelete: (media: MediaRow) => void;
    onOpenFileLocation?: (media: MediaRow) => void;
    onOpenSourceInYoutube?: (media: MediaRow) => void;
    onMarkWatched?: (media: MediaRow) => void;
    onMarkUnwatched?: (media: MediaRow) => void;
    // True while this card's own watched/unwatched toggle is in flight (see
    // MediaLibraryController.watchedActionInFlight), so the menu action disables instead of
    // silently doing nothing on a second click while the first is still running.
    isWatchedActionInFlight?: boolean;
    onEditTitle?: (media: MediaRow) => void;
};

export const MEDIA_CARD_HEIGHT = 292;
const MEDIA_TITLE_HEIGHT = 44;
const MEDIA_FOOTER_HEIGHT = 28;

// Style values that never depend on the card's props or state, hoisted to module scope so they
// are built once instead of on every render. Truly only the delta that reacts to state stays
// inline below: the media-type badge reacts only to isAudio (a boolean), so both of its variants
// are fully hoisted and picked between; the root card keeps its static base here
// (ROOT_CARD_BASE_STYLE) and spreads only the few properties that react to isActive/isWatched/
// shellBorder over it. This component is memoized and re-renders whenever its own primitive props
// flip (e.g. the active-media id changes), so avoiding the per-render work compounds across a
// virtualized grid of cards. The thumbnail block's own hoisted styles moved with it into
// `media-card-thumbnail.tsx`.
const CONTENT_STACK_STYLE: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
};

const TITLE_GROUP_STYLE: CSSProperties = {
    height: rem(MEDIA_TITLE_HEIGHT),
    minHeight: rem(MEDIA_TITLE_HEIGHT),
    maxHeight: rem(MEDIA_TITLE_HEIGHT),
};

const FOOTER_GROUP_STYLE: CSSProperties = {
    height: rem(MEDIA_FOOTER_HEIGHT),
    minHeight: rem(MEDIA_FOOTER_HEIGHT),
    maxHeight: rem(MEDIA_FOOTER_HEIGHT),
    marginTop: "auto",
};

const TITLE_BOX_STYLE: CSSProperties = {
    minWidth: 0,
    flex: 1,
};

const TITLE_TEXT_STYLE: CSSProperties = {
    lineHeight: 1.25,
};

const PUBLISHED_TEXT_STYLE: CSSProperties = {
    minWidth: 0,
    flex: 1,
};


const COMMENTS_BADGE_STYLE: CSSProperties = {
    flexShrink: 0,
    background: "light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.055))",
    borderColor: "light-dark(rgba(0,0,0,0.14), rgba(255,255,255,0.14))",
    color: "light-dark(rgba(0,0,0,0.66), rgba(255,255,255,0.74))",
    fontWeight: 700,
    paddingInline: rem(8),
};

// The media-type badge only ever takes one of two forms (audio/video), so both are hoisted and
// selected by isAudio at render time instead of rebuilding the object each render.
const MEDIA_TYPE_BADGE_STYLE_AUDIO: CSSProperties = {
    flexShrink: 0,
    background: "rgba(249,115,22,0.13)",
    borderColor: "rgba(249,115,22,0.34)",
    color: MEDIA_TYPE_ACCENT_COLOR.audio,
    fontWeight: 800,
};

const MEDIA_TYPE_BADGE_STYLE_VIDEO: CSSProperties = {
    flexShrink: 0,
    background: "rgba(59,130,246,0.13)",
    borderColor: "rgba(59,130,246,0.34)",
    color: MEDIA_TYPE_ACCENT_COLOR.video,
    fontWeight: 800,
};

// The media-type badge carries an icon where the others carry text, and Badge lays its label out
// for text. Without this the glyph sits on the text baseline instead of the middle of the pill.
// Only the centring lives here. Height, padding and colour stay on the two style objects above,
// which is what keeps this badge the same size as CHAT and the comment count beside it.
const MEDIA_TYPE_BADGE_LABEL_STYLE: CSSProperties = {
    display: "flex",
    alignItems: "center",
};

// The resting elevation of a card that is neither active nor watched.
//
// `light-dark()` resolves a *color*, so it has to sit in the color slot of each shadow, not around
// the shadow as a whole. Wrapping the whole thing (`light-dark(0 6px 18px <color>, 0 12px 32px
// <color>)`) makes the declaration invalid, and that had two consequences: no card ever got its
// resting shadow, and (worse), a card that had been the active one kept the violet active glow
// forever, because assigning an invalid value to an element's inline style is ignored and leaves the
// previous valid value in place. So the highlight survived the media being closed, on every card the
// user had ever opened.
//
// Both geometries are kept by emitting both shadows and letting each one be transparent in the theme
// it does not belong to, which preserves the original per-theme look exactly.
const INACTIVE_CARD_SHADOW =
    "0 6px 18px light-dark(rgba(26,24,37,0.10), transparent)," +
    " 0 12px 32px light-dark(transparent, rgba(0,0,0,0.12))";

// The static base of the root card. Only the four properties that react to isActive/isWatched
// (background, borderColor, boxShadow, transform) are spread over this inline below; the rest (// including the rem() height and the long transition string) is built once here.
const ROOT_CARD_BASE_STYLE: CSSProperties = {
    height: rem(MEDIA_CARD_HEIGHT),
    cursor: "pointer",
    outline: "none",
    transition:
        "transform 140ms ease, border-color 140ms ease, background 140ms ease, box-shadow 140ms ease",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
};

function MediaCardComponent({
    media,
    libraryPath,
    displayThumbnailPath,
    shellBorder,
    isActive = false,
    onOpen,
    onRequestDelete,
    onOpenFileLocation,
    onOpenSourceInYoutube,
    onMarkWatched,
    onMarkUnwatched,
    isWatchedActionInFlight = false,
    onEditTitle,
}: MediaCardProps): JSX.Element {
    const isAudio = media.media_type === "audio";
    const isLive = Boolean(media.is_live);
    const hasLiveChat = Boolean(media.has_live_chat);
    // Names the media type once. The tooltip and the aria-label have to say the same thing,
    // since the icon is the only other way to tell them apart.
    const mediaTypeLabel = isAudio
        ? UI_TEXT.library.mediaTypeAudio
        : UI_TEXT.library.mediaTypeVideo;
    const isWatched = isMediaWatched(media);
    const publishedLabel = formatPublishedDate(media.published_at);
    const commentsCount = media.comments_count;

    const handleOpen = (): void => {
        onOpen(media);
    };

    return (
        <StretchedButtonCard
            // Watched state rides on the accessible name because it has no badge of its own any
            // more (see the thumbnail's top-badge group). Appended rather than prefixed so the
            // action stays the first thing announced, and only when true, so an unwatched card's
            // name is unchanged.
            ariaLabel={
                isWatched
                    ? `Open ${media.title}, ${UI_TEXT.library.watchedBadge}`
                    : `Open ${media.title}`
            }
            onClick={handleOpen}
            radius="xl"
            p="sm"
            style={{
                ...ROOT_CARD_BASE_STYLE,
                // The watched tint carries a real cost when it is too faint, and it was: in dark
                // mode it painted 7% green over a card whose unwatched state is already 2.8% white,
                // so at grid scale the two read as the same card and the badge was doing the whole
                // job alone. The values below keep the intended ranking (active outranks watched
                // outranks neither), while making the middle rung visible rather than nominal.
                //
                // Active still wins on more than alpha: it also gets the ring, the drop glow and the
                // lift below, none of which watched has. That is what lets watched sit this close in
                // tint without the two competing for "which card am I on".
                background: isActive
                    ? "light-dark(linear-gradient(180deg, rgba(124,92,255,0.12), rgba(124,92,255,0.04)), linear-gradient(180deg, rgba(124,92,255,0.18), rgba(124,92,255,0.05)))"
                    : isWatched
                    ? "light-dark(linear-gradient(180deg, rgba(34,197,94,0.18), rgba(34,197,94,0.07)), linear-gradient(180deg, rgba(34,197,94,0.16), rgba(34,197,94,0.06)))"
                    : "light-dark(#ffffff, rgba(255,255,255,0.028))",
                borderColor: isActive
                    ? "rgba(124,92,255,0.68)"
                    : isWatched
                    ? "rgba(34,197,94,0.55)"
                    : shellBorder,
                boxShadow: isActive
                    ? "0 0 0 1px rgba(124,92,255,0.24), 0 18px 42px rgba(80,50,180,0.22)"
                    : INACTIVE_CARD_SHADOW,
                transform: isActive ? "translateY(-2px)" : "none",
            }}
        >
            <MediaCardThumbnail
                title={media.title}
                thumbnailPath={media.thumbnail_path}
                libraryPath={libraryPath}
                displayThumbnailPath={displayThumbnailPath}
                isAudio={isAudio}
                isActive={isActive}
                isWatched={isWatched}
                durationLabel={formatDuration(media.duration_seconds)}
                shellBorder={shellBorder}
            />

            <Stack gap={6} mt="sm" style={CONTENT_STACK_STYLE}>
                <Group
                    justify="space-between"
                    wrap="nowrap"
                    gap="xs"
                    align="start"
                    style={TITLE_GROUP_STYLE}
                >
                    <Box style={TITLE_BOX_STYLE}>
                        <Text
                            fw={900}
                            lineClamp={2}
                            title={media.title}
                            c={isActive ? "violet.1" : undefined}
                            style={TITLE_TEXT_STYLE}
                        >
                            {media.title}
                        </Text>
                    </Box>

                    <MediaCardActionsMenu
                        media={media}
                        isWatched={isWatched}
                        isWatchedActionInFlight={isWatchedActionInFlight}
                        onRequestDelete={onRequestDelete}
                        onOpenFileLocation={onOpenFileLocation}
                        onOpenSourceInYoutube={onOpenSourceInYoutube}
                        onMarkWatched={onMarkWatched}
                        onMarkUnwatched={onMarkUnwatched}
                        onEditTitle={onEditTitle}
                    />
                </Group>

                <Group
                    justify="space-between"
                    align="center"
                    gap="xs"
                    wrap="nowrap"
                    style={FOOTER_GROUP_STYLE}
                >
                    <Text size="xs" c="dimmed" truncate style={PUBLISHED_TEXT_STYLE}>
                        {publishedLabel || UI_TEXT.library.noPublicationDate}
                    </Text>

                    <Group gap={6} wrap="nowrap">
                        {/* One badge for both facts. LIVE says the media came from a
                            livestream, and the chat glyph inside it says that stream's
                            replay was saved, which is a property of the live rather than
                            a peer of it. It used to be a CHAT badge here and a LIVE
                            badge over the thumbnail. */}
                        {isLive && (
                            <Badge
                                variant="filled"
                                style={LIVE_BADGE_STYLE}
                                leftSection={<Radio size={12} />}
                                rightSection={
                                    hasLiveChat ? (
                                        <Tooltip label="Live chat replay saved" withArrow>
                                            {/* A property of the live, not a peer of it. Dimmed
                                                and set off from the word so it reads as a note on
                                                the badge rather than a control at the end of it.
                                                No container of its own, which is what was making
                                                it look like a toggle. */}
                                            <Box
                                                component="span"
                                                role="img"
                                                aria-label="Live chat replay saved"
                                                style={{
                                                    display: "flex",
                                                    opacity: 0.75,
                                                    marginInlineStart: rem(3),
                                                }}
                                            >
                                                <MessageCircle size={11} />
                                            </Box>
                                        </Tooltip>
                                    ) : undefined
                                }
                            >
                                LIVE
                            </Badge>
                        )}

                        {commentsCount > 0 && (
                            <Badge
                                variant="outline"
                                leftSection={<MessageCircle size={12} />}
                                style={COMMENTS_BADGE_STYLE}
                            >
                                {commentsCount}
                            </Badge>
                        )}

                        {/* Audio and video are an icon rather than a word. The pair shows up on
                            every card in the grid, so spelling it out was repeating the same two
                            words down the whole column for a distinction the icon makes at a
                            glance. LIVE keeps its text because it is the rarer signal and
                            because it is meant to be loud.

                            role="img" rather than a bare aria-label, which a screen reader is free
                            to ignore on a plain container. It does not reach the card's own
                            accessible name, which the ariaLabel prop above sets explicitly. */}
                        <Tooltip label={mediaTypeLabel} withArrow>
                            <Badge
                                variant="outline"
                                role="img"
                                aria-label={mediaTypeLabel}
                                style={
                                    isAudio
                                        ? MEDIA_TYPE_BADGE_STYLE_AUDIO
                                        : MEDIA_TYPE_BADGE_STYLE_VIDEO
                                }
                                styles={{ label: MEDIA_TYPE_BADGE_LABEL_STYLE }}
                            >
                                {isAudio ? (
                                    <Headphones size={12} />
                                ) : (
                                    <Video size={12} />
                                )}
                            </Badge>
                        </Tooltip>
                    </Group>
                </Group>
            </Stack>
        </StretchedButtonCard>
    );
}

// Memoized so that unrelated state changes higher up (player, modals, sidebar) do not
// re-render every visible card. Relies on the handlers passed by Home being stable.
export const MediaCard = memo(MediaCardComponent);
