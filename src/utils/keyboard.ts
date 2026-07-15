import type { KeyboardEvent } from "react";

/**
 * Builds an `onKeyDown` handler that activates a click-like control with the keyboard.
 *
 * For elements that are given `role="button"` but are not native `<button>`s - e.g. a Mantine
 * `<Anchor>` styled as a link, which renders an `<a>` without an `href` and is therefore not
 * keyboard-operable on its own - this restores the expected behavior: Enter and Space trigger
 * the action, and Space's default page-scroll is suppressed. Pair it with `role="button"` and
 * `tabIndex={0}` so the control is also focusable.
 *
 * The key is also claimed (`stopPropagation`), not just `preventDefault`ed: these controls are
 * rendered inside the player (comment and live chat author links), and the player's shortcuts
 * listen on `document` (`use-player-keyboard-shortcuts`). That listener only skips real form
 * fields, so an `<a role="button">` does not look like a typing target to it - without stopping
 * the event, pressing Space on an author link would open the channel *and* toggle play/pause on
 * the video behind it. `preventDefault` alone does not stop propagation.
 */
export function activateOnEnterOrSpace(onActivate: () => void) {
    return (event: KeyboardEvent): void => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onActivate();
        }
    };
}
