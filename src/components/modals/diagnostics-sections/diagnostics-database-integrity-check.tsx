import { Box, Code, Group, Stack, Text } from "@mantine/core";
import { CheckCircle2, XCircle } from "lucide-react";
import { useState } from "react";
import { checkDatabaseIntegrity } from "../../../services/database-service";
import { logError } from "../../../utils/app-logger";
import { resolveErrorMessage } from "../../../utils/error-message";
import { AppButton } from "../../ui/app-button";

type IntegrityResult =
    | { status: "ok" }
    | { status: "problem"; problems: string[]; truncated: boolean }
    | { status: "error"; message: string };

export function DiagnosticsDatabaseIntegrityCheck(): JSX.Element {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<IntegrityResult | null>(null);

    async function runCheck(): Promise<void> {
        setLoading(true);
        setResult(null);

        try {
            const report = await checkDatabaseIntegrity();
            setResult(
                report.ok
                    ? { status: "ok" }
                    : {
                          status: "problem",
                          problems: report.problems,
                          truncated: report.truncated,
                      }
            );
        } catch (error) {
            logError("diagnostics", "Failed to run the database integrity check.", error);
            setResult({
                status: "error",
                message: resolveErrorMessage(error, "Failed to run the integrity check."),
            });
        } finally {
            setLoading(false);
        }
    }

    return (
        <Stack gap="xs">
            <Group justify="space-between" align="center" wrap="wrap" gap="sm">
                <AppButton
                    type="button"
                    appVariant="secondary"
                    onClick={() => void runCheck()}
                    loading={loading}
                >
                    Run full integrity check
                </AppButton>

                {/* Persistent live region so the check's outcome is announced to screen readers
                    when it lands, instead of only being a visual color/icon change. */}
                <Box role="status" aria-live="polite">
                    {result?.status === "ok" && (
                        <Group gap={6} c="green">
                            <CheckCircle2 size={16} />
                            <Text size="sm">No problems found</Text>
                        </Group>
                    )}

                    {result?.status === "problem" && (
                        <Group gap={6} c="red">
                            <XCircle size={16} />
                            <Text size="sm">Integrity check reported a problem</Text>
                        </Group>
                    )}

                    {result?.status === "error" && (
                        <Group gap={6} c="red">
                            <XCircle size={16} />
                            <Text size="sm">{result.message}</Text>
                        </Group>
                    )}
                </Box>
            </Group>

            {/* What SQLite actually reported. A bare "there is a problem" leaves nothing to act on
                or to put in a bug report, and the app already has the answer to this: restoring
                from one of the automatic backups, in Settings. */}
            {result?.status === "problem" && (
                <Stack gap={4}>
                    <Text size="sm" c="dimmed">
                        Your data is still on disk. To recover, open Settings and restore the
                        database from a backup - Kavynex keeps several automatic snapshots.
                    </Text>

                    {result.problems.length > 0 && (
                        <Box>
                            <Text size="xs" fw={600} mb={4}>
                                SQLite reported:
                            </Text>

                            <Code block style={{ maxHeight: 160, overflowY: "auto" }}>
                                {result.problems.join("\n")}
                            </Code>

                            {result.truncated && (
                                <Text size="xs" c="dimmed" mt={4}>
                                    Only the first {result.problems.length} problems are shown.
                                </Text>
                            )}
                        </Box>
                    )}
                </Stack>
            )}
        </Stack>
    );
}
