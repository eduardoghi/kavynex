import type { CSSProperties } from "react";
import { rem } from "@mantine/core";

// The media picker and the thumbnail picker are the same control twice, and had drifted into
// different radii, preview sizes and border colours. They read from here so they cannot drift
// again.
//
// The selected state used to be violet, on the outer border and on the preview square. That is a
// lot of accent for "a file is chosen", which the file name and the type badge already state, so
// the border is neutral in both states and the colour is left for interaction.
export const FILE_PICKER_RADIUS = rem(14);
export const FILE_PICKER_PADDING = rem(16);
export const FILE_PICKER_BORDER_COLOR = "light-dark(rgba(0,0,0,0.18), rgba(255,255,255,0.18))";
export const FILE_PICKER_BACKGROUND = "light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.02))";

/**
 * The leading square holding the media icon or the thumbnail preview.
 *
 * `overflow: hidden` matters only to the thumbnail, which puts an `img` in here, but it costs the
 * media picker nothing and keeping one object is the point.
 */
export const FILE_PICKER_PREVIEW_STYLE: CSSProperties = {
    width: rem(42),
    height: rem(42),
    display: "grid",
    placeItems: "center",
    borderRadius: rem(12),
    border: "1px solid light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.12))",
    background: "light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.03))",
    flex: "0 0 auto",
    overflow: "hidden",
};
