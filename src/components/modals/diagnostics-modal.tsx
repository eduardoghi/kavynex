import { Box, Group, Loader, Modal, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { FolderOpen, RefreshCcw } from "lucide-react";
import { useState } from "react";
import { useModalLock } from "../../hooks/use-modal-lock";
import type {
    DiagnosticsMediaTarget,
    DiagnosticsSummary,
    KeptFolder,
} from "../../types/diagnostics";
import { formatBytes } from "../../utils/media-utils";
import { formatCount } from "../../utils/pluralize";
import { AppButton } from "../ui/app-button";
import { MODAL_CLOSE_BUTTON_STYLE, MODAL_TITLE_STYLE } from "../ui/modal-chrome";
import { ConfirmDeleteModal } from "./confirm-delete-modal";
import { DiagnosticsIssuesSection } from "./diagnostics-sections/diagnostics-issues-section";
import { DiagnosticsSummarySections } from "./diagnostics-sections/diagnostics-summary-sections";

type DiagnosticsModalProps = {
    opened: boolean;
    onClose: () => void;
    onReload: () => void;
    loading: boolean;
    summary: DiagnosticsSummary | null;
    onOpenMedia?: (target: DiagnosticsMediaTarget) => void;
    // Reveals one of an issue's example files in the OS file manager, by its library-relative path.
    // Only reaches the issues whose examples name a file that is on disk; the section decides that
    // from the issue itself. Optional for the same reason as the two below.
    onRevealPath?: (path: string) => void;
    // Reveals the app's log directory in the OS file manager. Optional so the modal still renders
    // bare in isolation tests; the app always supplies it.
    onOpenLogFolder?: () => void;
    openingLogFolder?: boolean;
    // Moves the orphan files the app recognizes as its own to the library's trash, after a
    // confirmation. Optional for the same reason as the two above.
    onRemoveOrphanFiles?: () => Promise<void>;
    removingOrphanFiles?: boolean;
    // Opens the recovered downloads folder or the library trash. Optional for the same reason.
    onOpenKeptFolder?: (folder: KeptFolder) => void;
};

export function DiagnosticsModal({
    opened,
    onClose,
    onReload,
    loading,
    summary,
    onOpenMedia,
    onRevealPath,
    onOpenLogFolder,
    openingLogFolder = false,
    onRemoveOrphanFiles,
    removingOrphanFiles = false,
    onOpenKeptFolder,
}: DiagnosticsModalProps): JSX.Element {
    const [confirmRemoveOrphansOpen, setConfirmRemoveOrphansOpen] = useState(false);
    const [isCompacting, setIsCompacting] = useState(false);
    const modalLock = useModalLock(isCompacting, onClose);
    const showInitialLoading = loading && !summary;
    const showRefreshingState = loading && !!summary;
    const orphanRemoval = summary?.diagnostics.orphanRemoval ?? null;

    return (
        <Modal
            opened={opened}
            title="Diagnostics"
            centered
            size="min(1200px, 96vw)"
            overlayProps={{ blur: 6 }}
            // Mantine's header close button is an icon with no text, so without this it has no
            // accessible name. Same shape as the settings and import modals.
            closeButtonProps={{
                "aria-label": "Close diagnostics",
                style: MODAL_CLOSE_BUTTON_STYLE,
            }}
            {...modalLock}
            styles={{
                content: {
                    height: "min(90vh, 980px)",
                    display: "flex",
                    flexDirection: "column",
                },
                title: MODAL_TITLE_STYLE,
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

                    <Group gap="sm" wrap="nowrap">
                        {onOpenLogFolder && (
                            // The README asks for the relevant log lines when reporting a bug and
                            // then gives a per-OS path to go and find. This is that path, as a
                            // button, in the dialog a user already opens when something looks wrong.
                            <AppButton
                                type="button"
                                appVariant="secondary"
                                leftSection={<FolderOpen size={16} />}
                                onClick={onOpenLogFolder}
                                loading={openingLogFolder}
                                disabled={openingLogFolder}
                            >
                                Open log folder
                            </AppButton>
                        )}

                        <AppButton
                            type="button"
                            appVariant="secondary"
                            leftSection={<RefreshCcw size={16} />}
                            onClick={onReload}
                            loading={loading}
                        >
                            Refresh
                        </AppButton>
                    </Group>
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
                                    <DiagnosticsSummarySections
                                        summary={summary}
                                        onCompactingChange={setIsCompacting}
                                    />
                                    <DiagnosticsIssuesSection
                                        issues={summary.issues}
                                        onOpenMedia={onOpenMedia}
                                        onRevealPath={onRevealPath}
                                        onRemoveOrphans={
                                            onRemoveOrphanFiles
                                                ? () => setConfirmRemoveOrphansOpen(true)
                                                : undefined
                                        }
                                        removingOrphans={removingOrphanFiles}
                                        orphanRemoval={orphanRemoval}
                                        onOpenKeptFolder={onOpenKeptFolder}
                                    />
                                </>
                            )}
                        </Stack>
                    </ScrollArea>
                </Box>
            </Stack>

            {onRemoveOrphanFiles && (
                <ConfirmDeleteModal
                    opened={confirmRemoveOrphansOpen}
                    onClose={() => setConfirmRemoveOrphansOpen(false)}
                    onConfirm={() => {
                        void onRemoveOrphanFiles().finally(() =>
                            setConfirmRemoveOrphansOpen(false)
                        );
                    }}
                    title={<Text fw={900}>Remove orphan files</Text>}
                    message={
                        orphanRemoval
                            ? `Move ${formatCount(orphanRemoval.files, "file")} (${formatBytes(orphanRemoval.bytes)}) that nothing in the library uses to the trash?`
                            : "Move the files that nothing in the library uses to the trash?"
                    }
                    description="Only media and thumbnails Kavynex named itself are moved, to the .trash folder inside your library folder. They stay there for 30 days, so you can move one back by hand, and are then deleted. Anything you put in the library folder yourself is kept."
                    confirmLabel="Move to trash"
                    loading={removingOrphanFiles}
                />
            )}
        </Modal>
    );
}