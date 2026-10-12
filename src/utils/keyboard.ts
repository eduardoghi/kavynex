import type { KeyboardEvent } from "react";

/**
 * Builds an `onKeyDown` handler that activates a click-like control with the keyboard.
 *
 * For elements that are given `role="button"` but are not native `<button>`s, such as a Mantine
 * `<Anchor>` styled as a link, which renders an `<a>` without an `href` and is therefore not
 * keyboard-operable on its own. Enter and Space trigger the action, and Space's default page scroll
 * is suppressed. Pair it with `role="button"` and `tabIndex={0}` so the control is also focusable.
 *
 * The key is also claimed (`stopPropagation`), not just `preventDefault`ed. These controls sit
 * inside the player (comment and live chat author links), whose shortcuts listen on `document`.
 * Those apply only while focus is on the player itself or on nothing
 * (`use-player-keyboard-shortcuts`), so a focused link is already out of their reach. Stopping the
 * event keeps it that way for any other document listener, since `preventDefault` alone does not.
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
