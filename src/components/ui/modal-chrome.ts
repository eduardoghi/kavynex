import type { CSSProperties } from "react";
import { rem } from "@mantine/core";

/**
 * Title styling for the app's larger modals, passed through `styles.title`.
 *
 * A screen's own name was rendering at about the size of the section headings inside it, so
 * nothing said which was the page and which were its parts. Same family as those headings, a step
 * up in size and weight.
 *
 * Those section headings are `<Title order={3} size="h4">`. Mantine renders a modal's title as an
 * `h2`, so the sections under it are `h3` for the outline, sized as `h4` for the look they had when
 * they were `h4` outright. The old tag skipped a level, which axe reports (`heading-order`) and a
 * screen reader's heading navigation exposes as a section with no parent.
 */
export const MODAL_TITLE_STYLE: CSSProperties = {
    fontFamily: "var(--mantine-font-family-headings)",
    fontSize: rem(22),
    fontWeight: 800,
};

/**
 * Resting colour for a modal's close button, passed through `closeButtonProps.style`.
 *
 * On the theme colour it was the one violet thing in the header, competing with the title for a
 * control that only dismisses the screen. Only the resting colour is set, so Mantine's own hover
 * tint and the keyboard focus ring still apply, and size and position are untouched.
 */
export const MODAL_CLOSE_BUTTON_STYLE: CSSProperties = {
    color: "light-dark(rgba(0,0,0,0.62), rgba(255,255,255,0.66))",
};
