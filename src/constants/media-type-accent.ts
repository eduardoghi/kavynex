/**
 * The colour each media type is drawn in, wherever the app marks one.
 *
 * The library card states the type with a `Headphones` or `Video` glyph in these colours, and the
 * import modal's file picker now does the same, so somebody who learned the pair in the grid reads
 * it in the modal without being taught twice. One place, so the two cannot drift into two shades of
 * orange.
 */
export const MEDIA_TYPE_ACCENT_COLOR = {
    audio: "light-dark(#C2410C, rgb(253,186,116))",
    video: "light-dark(#1D4ED8, rgb(147,197,253))",
} as const;
