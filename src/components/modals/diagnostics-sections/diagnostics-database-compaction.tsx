import { Box, Group, Stack, Text } from "@mantine/core";
import { CheckCircle2, XCircle } from "lucide-react";
import { useDatabaseCompaction } from "../../../hooks/use-database-compaction";
import { AppButton } from "../../ui/app-button";

export function DiagnosticsDatabaseCompaction(): JSX.Element {
    const { loading, result, runCompaction } = useDatabaseCompaction();

    return (
        <Stack gap="xs">
            <Group justify="space-between" align="center" wrap="wrap" gap="sm">
                <AppButton
                    type="button"
                    appVariant="secondary"
                    onClick={() => void runCompaction()}
                    loading={loading}
                >
                    Compact database
                </AppButton>

                <Box role="status" aria-live="polite">
                    {result?.status === "freed" && (
                        <Group gap={6} c="green">
                            <CheckCircle2 size={16} />
                            <Text size="sm">Freed {result.formattedSize}</Text>
                        </Group>
                    )}

                    {result?.status === "nothing" && (
                        <Group gap={6} c="green">
                            <CheckCircle2 size={16} />
                            <Text size="sm">There was no unused space to free</Text>
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

            <Text size="xs" c="dimmed">
                Gives the space left by deleted media and comments back to the disk. It rewrites the
                whole database, so it can take a while on a large library and needs free space of
                up to twice the database size.
            </Text>
        </Stack>
    );
}
