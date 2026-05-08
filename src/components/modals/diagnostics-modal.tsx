import { Box, Group, Loader, Modal, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { RefreshCcw } from "lucide-react";
import type { DiagnosticsSummary } from "../../types/diagnostics";
import { AppButton } from "../ui/app-button";
import { DiagnosticsIssuesSection } from "./diagnostics-sections/diagnostics-issues-section";
import { DiagnosticsSummarySections } from "./diagnostics-sections/diagnostics-summary-sections";

type DiagnosticsModalProps = {
    opened: boolean;
    onClose: () => void;
    onReload: () => void;
    loading: boolean;
    summary: DiagnosticsSummary | null;
};

export function DiagnosticsModal({
    opened,
    onClose,
    onReload,
    loading,
    summary,
}: DiagnosticsModalProps): JSX.Element {
    const showInitialLoading = loading && !summary;
    const showRefreshingState = loading && !!summary;

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title="Diagnostics"
            centered
            size="min(1200px, 96vw)"
            overlayProps={{ blur: 6 }}
            styles={{
                content: {
                    height: "min(90vh, 980px)",
                    display: "flex",
                    flexDirection: "column",
                },
                header: {
                    paddingBottom: 12,
                },
                body: {
                    flex: 1,
                    overflow: "hidden",
                    paddingTop: 0,
                },
            }}
        >
            <Stack gap="md" h="100%">
                <Box
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 16,
                        paddingRight: 16,
                    }}
                >
                    <Text c="dimmed" size="sm">
                        Environment, database and library health overview
                    </Text>

                    <AppButton
                        type="button"
                        appVariant="primary"
                        leftSection={<RefreshCcw size={16} />}
                        onClick={onReload}
                        loading={loading}
                    >
                        Refresh
                    </AppButton>
                </Box>

                <Box
                    style={{
                        flex: 1,
                        minHeight: 0,
                        overflow: "hidden",
                    }}
                >
                    <ScrollArea h="100%" offsetScrollbars scrollbarSize={10} type="scroll">
                        <Stack gap="md" pr="xs">
                            {showInitialLoading && (
                                <Paper withBorder radius="lg" p="xl">
                                    <Stack align="center" gap="sm">
                                        <Loader size="sm" />
                                        <Text c="dimmed">Loading diagnostics.</Text>
                                    </Stack>
                                </Paper>
                            )}

                            {showRefreshingState && (
                                <Paper withBorder radius="lg" p="sm">
                                    <Group gap="sm">
                                        <Loader size="xs" />
                                        <Text size="sm" c="dimmed">
                                            Refreshing diagnostics...
                                        </Text>
                                    </Group>
                                </Paper>
                            )}

                            {!loading && !summary && (
                                <Paper withBorder radius="lg" p="xl">
                                    <Stack align="center" gap="sm">
                                        <Text fw={700}>No diagnostics loaded</Text>
                                        <Text c="dimmed" size="sm" ta="center">
                                            Click refresh to load the current environment status.
                                        </Text>
                                    </Stack>
                                </Paper>
                            )}

                            {summary && (
                                <>
                                    <DiagnosticsSummarySections summary={summary} />
                                    <DiagnosticsIssuesSection issues={summary.issues} />
                                </>
                            )}
                        </Stack>
                    </ScrollArea>
                </Box>
            </Stack>
        </Modal>
    );
}