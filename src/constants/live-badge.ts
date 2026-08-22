import type { CSSProperties } from "react";

/**
 * The look of the LIVE marker, shared by the library card and the player header.
 *
 * LIVE says the media came from a livestream. It is not a claim that anything is streaming now,
 * which is why it reads as a marker on the item rather than as a status indicator.
 *
 * The two places that draw it had drifted apart: the card used Mantine's red filled, the header the
 * same red at `light`, so one fact arrived at two intensities and in a red the rest of the app does
 * not use. This is the red the CHAT badge and the live chat panel already carry, and it stays
 * filled, because the card's copy sits over a thumbnail and because LIVE outranks the CHAT badge
 * beside it. Pulled back from full saturation so it marks rather than alarms.
 */
export const LIVE_BADGE_STYLE: CSSProperties = {
    background: "rgba(220,38,38,0.88)",
    border: "1px solid rgba(239,68,68,0.55)",
    color: "#ffffff",
};
