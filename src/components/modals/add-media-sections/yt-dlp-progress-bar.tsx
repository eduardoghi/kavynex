import { Group, Progress, Text } from "@mantine/core";
import type { YtDlpPhase, YtDlpProgress } from "../../../services/yt-dlp-progress";

// What each stage is called on screen. A `Record` over the union rather than a conditional chain, so
// a phase added in `yt-dlp-progress.ts` fails to compile here instead of rendering as a blank label.
//
// Worded for someone who has never read yt-dlp's output, which is the whole point of this bar. The
// terminal below already shows `[Merger] Merging formats into "..."` verbatim, and that line is the
// one users read as the app having frozen.
const PHASE_LABEL: Record<YtDlpPhase, string> = {
    downloading: "Downloading",
    merging: "Combining video and audio",
    "extracting-audio": "Extracting audio",
    "embedding-thumbnail": "Adding the thumbnail",
    "writing-metadata": "Writing metadata",
    "converting-thumbnail": "Converting the thumbnail",
};

type YtDlpProgressBarProps = {
    progress: YtDlpProgress | null;
    isRunning: boolean;
};

/**
 * The download's progress, above the terminal.
 *
 * Nothing here is new information. Every value comes from lines the terminal was already printing.
 * What it adds is a reading of them that does not require knowing yt-dlp, and it matters most in the
 * stage that has no percentage. A merge writes one line and then works silently for minutes on a
 * large file, so the honest rendering of that is a bar that says it is still working rather than a
 * bar frozen at whatever the download left behind.
 */
export function YtDlpProgressBar({
    progress,
    isRunning,
}: YtDlpProgressBarProps): JSX.Element | null {
    // Nothing to show before the first stage line arrives, and nothing to show once the run ends.
    // A bar left on screen after a finished or cancelled run reports a state that is over.
    if (!isRunning || !progress) {
        return null;
    }

    const label = PHASE_LABEL[progress.phase];
    const percent = progress.percent;

    // A post-processing stage reports no percentage, so the bar is filled and animated rather than
    // empty. An empty bar would read as no progress at all, which is the opposite of what is
    // happening, and a bar stuck at the download's last value would read as finished.
    const isIndeterminate = percent === null;

    return (
        <>
            <Group justify="space-between" mb={6} gap="xs" wrap="nowrap">
                <Text size="sm" c="dimmed">
                    {label}
                </Text>

                <Text size="sm" c="dimmed" fw={600}>
                    {/* One decimal, matching what yt-dlp reports, so the number here and the number
                        in the terminal below agree. A stage with no percentage says so in words
                        rather than showing nothing: the right-hand side going blank reads as the
                        run having stopped, which is the impression this bar exists to correct. */}
                    {percent === null ? "working" : `${percent.toFixed(1)}%`}
                </Text>
            </Group>

            {isIndeterminate ? (
                // Decoration, and marked as such. Mantine's Progress always emits `aria-valuenow`
                // from `value`, so filling it to 100 to get the animation would announce "100%" to
                // a screen reader for a stage that has barely started. The text above already
                // carries the stage and the "working" state, so hiding the bar from the
                // accessibility tree loses nothing and stops it from claiming a measurement that
                // does not exist.
                <Progress value={100} animated striped size="sm" mb="sm" aria-hidden="true" />
            ) : (
                <Progress
                    value={percent}
                    size="sm"
                    mb="sm"
                    aria-label={`${label}, ${percent.toFixed(0)}%`}
                />
            )}
        </>
    );
}
