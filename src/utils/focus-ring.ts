// Marks an element so the keyboard focus ring is not drawn for one programmatic focus.
//
// `HTMLElement.focus({ focusVisible: false })` is the standard way to say "restore focus without
// showing the ring", but only Firefox implements it. Chromium (WebView2, the Windows target) and
// WebKit (the macOS/Linux targets) accept the option and ignore it. So on every engine Kavynex
// actually ships on, restoring focus to the card that opened the player drew the violet ring for a
// mouse user who never saw one, which reads as the card being stuck in a selected state.
//
// Dropping the focus restore instead is not an option: the grid stays mounted behind the player, so
// without it a keyboard or screen-reader user lands back on `<body>` with no position in the list.
// This keeps the restore and suppresses only the ring, by marking the element for exactly as long as
// that one programmatic focus lasts.
export const SUPPRESS_FOCUS_RING_ATTRIBUTE = "data-suppress-focus-ring";

/**
 * Suppresses the focus ring for the programmatic `focus()` call that follows, and only for it.
 *
 * The mark is released on the element's next `keydown` or `blur`, whichever comes first, so a
 * keyboard user who tabs or arrows away from the restored card gets the ring back immediately: the
 * suppression covers the restore itself, never the user's own subsequent navigation. Both listeners
 * remove each other, so nothing is left attached to a long-lived element.
 *
 * Call it immediately before `focus()`: the attribute has to be on the element when the style is
 * evaluated, not after.
 */
export function suppressFocusRingOnce(element: HTMLElement): void {
    element.setAttribute(SUPPRESS_FOCUS_RING_ATTRIBUTE, "");

    const release = (): void => {
        element.removeAttribute(SUPPRESS_FOCUS_RING_ATTRIBUTE);
        element.removeEventListener("keydown", release);
        element.removeEventListener("blur", release);
    };

    element.addEventListener("keydown", release);
    element.addEventListener("blur", release);
}
