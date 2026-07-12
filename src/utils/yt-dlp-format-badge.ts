import type { YtDlpFormat } from "../types/media";

// Pure mapping logic for the yt-dlp format badge shown in the add-media modal. Kept out of the
// component (yt-dlp-section.tsx) so the label/tone/style rules can be unit-tested in isolation
// and the component is left to render. The StatusBadge component itself stays in the component
// file; it consumes `BadgeTone` and `getBadgeStyle` from here.

export type BadgeTone = "neutral" | "violet" | "blue" | "green" | "orange" | "red" | "yellow";

export type BadgeStyle = {
    background: string;
    borderColor: string;
    color: string;
};

/** The short, uppercase label describing a selected yt-dlp format (or the empty state). */
export function buildFormatBadgeLabel(format: YtDlpFormat | null): string {
    if (!format) {
        return "NO FORMAT SELECTED";
    }

    const displayName = format.display_name.trim().toUpperCase();

    if (displayName.startsWith("MERGED")) {
        return "MERGED";
    }

    if (displayName.startsWith("NATIVE")) {
        return "NATIVE";
    }

    if (displayName.startsWith("VIDEO ONLY")) {
        return "VIDEO ONLY";
    }

    if (displayName.startsWith("AUDIO ONLY")) {
        return "AUDIO ONLY";
    }

    if (format.has_video && format.has_audio) {
        return "VIDEO + AUDIO";
    }

    if (format.has_video) {
        return "VIDEO ONLY";
    }

    return "AUDIO ONLY";
}

/** The logical color (tone) for a selected format's badge (or the empty state). */
export function buildFormatBadgeTone(format: YtDlpFormat | null): BadgeTone {
    if (!format) {
        return "neutral";
    }

    const displayName = format.display_name.trim().toUpperCase();

    if (displayName.startsWith("MERGED")) {
        return "violet";
    }

    if (displayName.startsWith("NATIVE")) {
        return "green";
    }

    if (displayName.startsWith("VIDEO ONLY")) {
        return "blue";
    }

    if (displayName.startsWith("AUDIO ONLY")) {
        return "orange";
    }

    if (format.has_video && format.has_audio) {
        return "green";
    }

    if (format.has_video) {
        return "blue";
    }

    return "orange";
}

/** Maps a badge tone to its concrete background/border/text colors. */
export function getBadgeStyle(tone: BadgeTone): BadgeStyle {
    if (tone === "violet") {
        return {
            background: "rgba(124,92,255,0.13)",
            borderColor: "rgba(139,92,246,0.34)",
            color: "rgb(221,214,254)",
        };
    }

    if (tone === "blue") {
        return {
            background: "rgba(59,130,246,0.13)",
            borderColor: "rgba(59,130,246,0.34)",
            color: "rgb(147,197,253)",
        };
    }

    if (tone === "green") {
        return {
            background: "rgba(34,197,94,0.13)",
            borderColor: "rgba(34,197,94,0.34)",
            color: "rgb(134,239,172)",
        };
    }

    if (tone === "orange") {
        return {
            background: "rgba(249,115,22,0.13)",
            borderColor: "rgba(249,115,22,0.34)",
            color: "rgb(253,186,116)",
        };
    }

    if (tone === "red") {
        return {
            background: "rgba(239,68,68,0.13)",
            borderColor: "rgba(239,68,68,0.34)",
            color: "rgb(252,165,165)",
        };
    }

    if (tone === "yellow") {
        return {
            background: "rgba(234,179,8,0.13)",
            borderColor: "rgba(234,179,8,0.34)",
            color: "rgb(253,224,71)",
        };
    }

    return {
        background: "rgba(255,255,255,0.055)",
        borderColor: "rgba(255,255,255,0.14)",
        color: "rgba(255,255,255,0.66)",
    };
}
