import { Box, Code, Group, Progress, Stack, Text } from "@mantine/core";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useLibraryVerification } from "../../../hooks/use-library-verification";
import type { ContentVerificationReport } from "../../../types/generated/ContentVerificationReport";
import { AppButton } from "../../ui/app-button";

type DiagnosticsContentVerificationProps = {
    libraryPath: string;
};

// The examples the report carries, rendered under a heading that says what they are. Kept to one
// component because the three categories differ only in wording, and repeating the block three
// times is how they drift apart.
function ExampleList({ title, paths }: { title: string; paths: string[] }): JSX.Element | null {
    if (paths.length === 0) {
        return null;
    }

    return (
        <Box>
            <Text size="xs" fw={600} mb={4}>
                {title}
            </Text>

            <Stack gap={2}>
                {paths.map((path) => (
                    <Code key={path} block>
                        {path}
                    </Code>
                ))}
            </Stack>
        </Box>
    );
}

// What a finished run means, in one sentence, before any of the detail below it.
//
// The cancelled case is called out first and deliberately. A partial run that found nothing must
// never read as "your library is fine", which is the one way this check could do harm.
function Outcome({ report }: { report: ContentVerificationReport }): JSX.Element {
    if (report.cancelled) {
        return (
            <Group gap={6} c="dimmed">
                <AlertTriangle size={16} />
                <Text size="sm">
                    Stopped early: {report.checked} file(s) checked, the rest were not. This is not
                    a clean result.
                </Text>
            </Group>
        );
    }

    if (report.corrupt > 0) {
        return (
            <Group gap={6} c="red">
                <XCircle size={16} />
                <Text size="sm">
                    {report.corrupt} file(s) do not match the content they were saved with
                </Text>
            </Group>
        );
    }

    return (
        <Group gap={6} c="green">
            <CheckCircle2 size={16} />
            <Text size="sm">
                All {report.verified} checked file(s) match the content they were saved with
            </Text>
        </Group>
    );
}

/**
 * The deep library check. re-reads every stored file and compares it against the hash in its name.
 *
 * Separate from the rest of Diagnostics, and behind a button, because it costs a full read of the
 * library. The summary above it is built from `stat` and opens instantly; this one can take as long
 * as reading every byte takes, which is why it reports progress and can be stopped.
 */
export function DiagnosticsContentVerification({
    libraryPath,
}: DiagnosticsContentVerificationProps): JSX.Element {
    const { running, progress, result, verify, cancel } = useLibraryVerification();

    const percent =
        progress && progress.total > 0
            ? Math.round((progress.checked / progress.total) * 100)
            : 0;

    return (
        <Stack gap="xs">
            <Text size="sm" c="dimmed">
                Reads every saved video, audio file and thumbnail and checks it against the content
                it was saved with. This catches damage the summary above cannot see, such as a file
                that is still the right size but whose contents were altered on disk. It reads your
                whole library, so it can take a while.
            </Text>

            <Group justify="space-between" align="center" wrap="wrap" gap="sm">
                <Group gap="sm">
                    <AppButton
                        type="button"
                        appVariant="secondary"
                        onClick={() => void verify(libraryPath)}
                        loading={running}
                        disabled={!libraryPath}
                    >
                        Verify saved files
                    </AppButton>

                    {running && (
                        <AppButton type="button" appVariant="secondary" onClick={() => void cancel()}>
                            Stop
                        </AppButton>
                    )}
                </Group>

                {/* Persistent live region so the outcome is announced when it lands, rather than
                    being only a colour and an icon. Matches the database integrity check above. */}
                <Box role="status" aria-live="polite">
                    {result?.status === "done" && <Outcome report={result.report} />}

                    {result?.status === "error" && (
                        <Group gap={6} c="red">
                            <XCircle size={16} />
                            <Text size="sm">{result.message}</Text>
                        </Group>
                    )}
                </Box>
            </Group>

            {running && progress && (
                <Box>
                    <Group justify="space-between" mb={4}>
                        <Text size="xs" c="dimmed">
                            {/* The count, not only the bar: on a large library the percentage moves
                                slowly enough to look stuck, and "412 of 3,208" visibly does not. */}
                            {progress.checked} of {progress.total} file(s)
                        </Text>
                        <Text size="xs" c="dimmed">
                            {percent}%
                        </Text>
                    </Group>

                    <Progress value={percent} size="sm" aria-label={`Verifying, ${percent}%`} />
                </Box>
            )}

            {result?.status === "done" && (
                <Stack gap={6}>
                    {result.report.corrupt > 0 && (
                        <Text size="sm" c="dimmed">
                            These files are still on disk but their contents changed after they were
                            saved. Re-download them if the source is still available, or restore them
                            from your own backup of the library folder.
                        </Text>
                    )}

                    <ExampleList
                        title="Files whose contents do not match:"
                        paths={result.report.corruptExamples}
                    />

                    <ExampleList
                        title="Files that could not be read:"
                        paths={result.report.unreadableExamples}
                    />

                    {result.report.unverifiable > 0 && (
                        <Text size="xs" c="dimmed">
                            {result.report.unverifiable} file(s) could not be checked because their
                            names do not record the content they hold. Files Kavynex saved always do;
                            these were most likely added or renamed by hand.
                        </Text>
                    )}
                </Stack>
            )}
        </Stack>
    );
}
