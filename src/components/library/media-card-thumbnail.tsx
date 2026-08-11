import { useState, type CSSProperties } from "react";
import { Badge, Box, Group, rem } from "@mantine/core";
import { Music, Play, Radio } from "lucide-react";
import { UI_TEXT } from "../../constants/ui-text";
import { fileSrcFromAbsolutePath, fileSrcFromStoredPath } from "../../utils/media-utils";

// The image block at the top of a media card: the thumbnail itself (with its missing-file
// fallback), the state badges laid over it, and the duration pill in its corner.
//
// Split out of `media-card.tsx` because it is the one part of a card that owns state. Everything
// else there is a pure function of the props, so the failed-thumbnail handling was the only reason
// that file had a `useState` at all - and it is state about the image, not about the card.
//
// It resolves its own `src` from the two paths rather than being handed one, so the "prefer the
// derivative, fall back to the stored file" rule lives with the element that draws the result.

const MEDIA_THUMBNAIL_HEIGHT = 158;

// Style values that never depend on props or state, hoisted to module scope so they are built once
// instead of on every render. The card around this is memoized and re-renders whenever its own
// primitive props flip (e.g. the active-media id changes), so avoiding the per-render work compounds
// across a virtualized grid.
const THUMBNAIL_IMG_STYLE: CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
};

const THUMBNAIL_PLACEHOLDER_STYLE: CSSProperties = {
    height: "100%",
    display: "grid",
    placeItems: "center",
    opacity: 0.95,
};

const TOP_BADGE_GROUP_STYLE: CSSProperties = {
    position: "absolute",
    top: rem(10),
    left: rem(10),
};

const DURATION_BADGE_STYLE: CSSProperties = {
    position: "absolute",
    right: rem(6),
    bottom: rem(6),
    background: "rgba(0, 0, 0, 0.78)",
    color: "#ffffff",
    fontWeight: 800,
    letterSpacing: rem(0.2),
    pointerEvents: "none",
};

// The static base of the container. Only the `border` (which reacts to isActive/isWatched and the
// shellBorder prop) is spread over this inline below; the three rem() sizes and the multi-layer
// gradient background are built once here.
const THUMBNAIL_CONTAINER_BASE_STYLE: CSSProperties = {
    height: rem(MEDIA_THUMBNAIL_HEIGHT),
    minHeight: rem(MEDIA_THUMBNAIL_HEIGHT),
    maxHeight: rem(MEDIA_THUMBNAIL_HEIGHT),
    borderRadius: rem(14),
    overflow: "hidden",
    position: "relative",
    background:
        "radial-gradient(220px 130px at 55% 35%, rgba(168,85,247,0.28), transparent 60%)," +
        "radial-gradient(260px 160px at 35% 65%, rgba(59,130,246,0.22), transparent 65%)," +
        "linear-gradient(180deg, rgba(0,0,0,0.38), rgba(0,0,0,0.52))",
    flexShrink: 0,
};

type MediaCardThumbnailProps = {
    title: string;
    // The library-relative path stored on the row, and the absolute path of the display-sized copy
    // when one has been resolved (see hooks/use-display-thumbnails.ts). The derivative is preferred
    // because the webview decodes an image at its natural size - a 1280x720 thumbnail costs the same
    // bitmap in a 280px card as it would full screen. Both are optional: absent is the ordinary
    // state on first paint and the permanent state whenever a derivative cannot be produced.
    thumbnailPath: string | null;
    libraryPath: string;
    displayThumbnailPath?: string;
    isAudio: boolean;
    isActive: boolean;
    isWatched: boolean;
    isLive: boolean;
    // Already formatted by the caller; empty means the media has no known duration.
    durationLabel: string;
    shellBorder: string;
};

export function MediaCardThumbnail({
    title,
    thumbnailPath,
    libraryPath,
    displayThumbnailPath,
    isAudio,
    isActive,
    isWatched,
    isLive,
    durationLabel,
    shellBorder,
}: MediaCardThumbnailProps): JSX.Element {
    // Both spellings go through the asset protocol - the derivative lives in the cache directory,
    // authorized in `setup()`, and the stored file under the library, authorized by
    // `register_library_asset_scope`.
    const storedThumbSrc = fileSrcFromStoredPath(thumbnailPath, libraryPath);
    const displayThumbSrc = fileSrcFromAbsolutePath(displayThumbnailPath ?? null);
    const thumbSrc = displayThumbSrc || storedThumbSrc;

    // Reset the failure when the thumbnail itself changes, so replacing a missing thumbnail with a
    // new one shows it rather than staying on the placeholder. Keying state to a value is cheaper
    // and less error-prone here than an effect: the grid keys cards by media id, so this only has
    // to cover the same card getting a new thumbnail.
    //
    // This is deliberately React's "adjust state directly during render" pattern (the set-state
    // call runs during render, React re-renders immediately before committing), NOT a useEffect.
    // Do not "fix" it into an effect: an effect would render one frame with the stale thumbFailed
    // (a flash of the broken-image placeholder) before resetting. See
    // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
    const [thumbFailed, setThumbFailed] = useState(false);
    const [thumbFailedFor, setThumbFailedFor] = useState(thumbSrc);

    if (thumbFailedFor !== thumbSrc) {
        setThumbFailedFor(thumbSrc);
        setThumbFailed(false);
    }

    return (
        /* The thumbnail carries the watched border too, not just the card around it. Of the card's
           292px this block is 158, so the outer border is a thin line drawn around a mass that is
           almost entirely image - the state has to appear on the part the eye is already looking at,
           or it is only technically on screen. Kept a step below the outer border's alpha so the
           card still reads as one shape rather than two rings. */
        <Box
            style={{
                ...THUMBNAIL_CONTAINER_BASE_STYLE,
                border: `1px solid ${
                    isActive
                        ? "rgba(124,92,255,0.52)"
                        : isWatched
                        ? "rgba(34,197,94,0.45)"
                        : shellBorder
                }`,
            }}
        >
            {thumbSrc && !thumbFailed ? (
                <img
                    src={thumbSrc}
                    alt={title}
                    loading="lazy"
                    decoding="async"
                    // A row can point at a thumbnail that is no longer on disk - the file was moved
                    // or deleted outside the app, which the Diagnostics dialog reports as "some
                    // thumbnail files are missing on disk". Without this the card renders the
                    // browser's broken-image glyph, which reads as the app being broken rather than
                    // as a missing file; the placeholder below is the same thing a media with no
                    // thumbnail at all shows.
                    onError={() => setThumbFailed(true)}
                    style={THUMBNAIL_IMG_STYLE}
                />
            ) : (
                <Box style={THUMBNAIL_PLACEHOLDER_STYLE}>
                    {isAudio ? <Music size={34} /> : <Play size={34} />}
                </Box>
            )}

            <Group gap="xs" style={TOP_BADGE_GROUP_STYLE}>
                {isActive && (
                    <Badge variant="filled" color="violet">
                        {UI_TEXT.library.selected}
                    </Badge>
                )}

                {/* Watched carries no badge here on purpose. The card's own green states it, and a
                    pill on top of the thumbnail was stating it twice while covering the top-left
                    corner - where a face or a YouTube thumbnail's own title text usually sits, i.e.
                    the part the user is scanning by.

                    The visual signal is therefore colour alone, which is a real limit rather than a
                    free win: a viewer with red-green colour blindness gets a weaker version of it (a
                    luminance shift rather than a hue). It is accepted for the cleaner grid. What is
                    not given up is the screen-reader signal - the card's accessible name carries the
                    state instead, so it is announced without occupying a pixel. */}
                {isLive && (
                    <Badge variant="filled" color="red" leftSection={<Radio size={12} />}>
                        LIVE
                    </Badge>
                )}
            </Group>

            {durationLabel && (
                <Badge variant="filled" color="dark" style={DURATION_BADGE_STYLE}>
                    {durationLabel}
                </Badge>
            )}
        </Box>
    );
}
