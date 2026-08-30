// Reads a yt-dlp output line as progress. How far the current file is, and which stage the run is
// in. Pure, so the parsing is testable without a download, and separate from `use-yt-dlp-events`
// because that hook's job is buffering the scrollback, not interpreting it.
//
// This exists because the terminal was the only progress the app offered. A download is the longest
// operation Kavynex performs (the backend bounds one at twelve hours), and the stage that most looks
// like a freeze is the one where yt-dlp is working correctly. The merge prints nothing for minutes
// while FFmpeg muxes a multi-gigabyte file. The backend already knows the difference (its stall
// watchdog checks whether the temp files are still growing before killing anything); nothing of that
// reached the screen, so the reasonable read of a silent terminal was "it hung", and cancelling a
// download at 90% is the action that follows.

// The stages a run passes through, in the order yt-dlp reports them. `downloading` is the only one
// that carries a percentage; the rest are post-processing steps that print once and then work
// silently, which is exactly why naming them is worth doing.
export type YtDlpPhase =
    | "downloading"
    | "merging"
    | "extracting-audio"
    | "embedding-thumbnail"
    | "writing-metadata"
    | "converting-thumbnail";

export type YtDlpProgress = {
    phase: YtDlpPhase;
    // Percent of the *current* file, or null when the stage does not report one.
    //
    // Per file, not per run, and the distinction is real rather than pedantic. A video+audio
    // selection downloads two files, so this reaches 100 and starts again at 0. Presenting it as
    // overall run progress would make the second pass look like a regression. The phase label is
    // what carries the rest of the story.
    percent: number | null;
};

// The bracketed stage prefix yt-dlp writes at the start of a progress or post-processing line.
const PHASE_BY_PREFIX: ReadonlyArray<readonly [string, YtDlpPhase]> = [
    ["[download]", "downloading"],
    ["[Merger]", "merging"],
    ["[ExtractAudio]", "extracting-audio"],
    ["[EmbedThumbnail]", "embedding-thumbnail"],
    ["[Metadata]", "writing-metadata"],
    ["[ThumbnailsConvertor]", "converting-thumbnail"],
];

// `[download]  42.3% of ...`, and the `100%` form yt-dlp writes without a decimal on completion.
// Anchored to the line start (after the prefix) so a percentage appearing inside a filename or a
// warning cannot be read as progress.
const PERCENT_PATTERN = /^\[download\]\s+(\d{1,3}(?:\.\d+)?)%/;

/**
 * The progress a line reports, or `null` when it reports none.
 *
 * A `[download]` line that carries no percentage (`Destination:`, `Resuming download at byte ...`)
 * still answers `downloading` with a null percent. The stage is known even when the number is not,
 * and returning null for the whole line would drop the phase back to whatever it was.
 */
export function parseYtDlpProgress(line: string): YtDlpProgress | null {
    const normalized = line.trim();

    if (!normalized) {
        return null;
    }

    const captured = PERCENT_PATTERN.exec(normalized)?.[1];

    if (captured !== undefined) {
        // Clamped rather than trusted. The value is parsed out of an external tool's output, and a
        // bar driven past 100 renders wrong rather than failing, which is the kind of thing nobody
        // reports.
        const parsedPercent = Number.parseFloat(captured);
        const percent = Math.min(100, Math.max(0, parsedPercent));

        return { phase: "downloading", percent: Number.isFinite(percent) ? percent : null };
    }

    const phase = PHASE_BY_PREFIX.find(([prefix]) => normalized.startsWith(prefix))?.[1];

    return phase ? { phase, percent: null } : null;
}

/**
 * The progress state after `line`, given what it was before.
 *
 * A stage change clears the percentage rather than carrying the previous one forward. The merge
 * inheriting the download's `100%` is precisely the reading that made a working run look finished
 * and then frozen. A `[download]` line with no percentage keeps the one already shown, so the bar
 * does not blink to indeterminate on every `Destination:` line.
 */
export function advanceYtDlpProgress(
    current: YtDlpProgress | null,
    line: string
): YtDlpProgress | null {
    const parsed = parseYtDlpProgress(line);

    if (!parsed) {
        return current;
    }

    if (parsed.percent !== null) {
        return parsed;
    }

    if (current && current.phase === parsed.phase) {
        return current;
    }

    return parsed;
}
