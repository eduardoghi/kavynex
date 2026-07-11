import type { KeyboardEvent } from "react";

/**
 * Builds an `onKeyDown` handler that activates a click-like control with the keyboard.
 *
 * For elements that are given `role="button"` but are not native `<button>`s - e.g. a Mantine
 * `<Anchor>` styled as a link, which renders an `<a>` without an `href` and is therefore not
 * keyboard-operable on its own - this restores the expected behavior: Enter and Space trigger
 * the action, and Space's default page-scroll is suppressed. Pair it with `role="button"` and
 * `tabIndex={0}` so the control is also focusable.
 */
export function activateOnEnterOrSpace(onActivate: () => void) {
    return (event: KeyboardEvent): void => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onActivate();
        }
    };
}
