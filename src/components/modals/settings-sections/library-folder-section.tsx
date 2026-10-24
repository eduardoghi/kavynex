import {
    Alert,
    Group,
    Paper,
    Progress,
    SimpleGrid,
    Stack,
    Text,
    TextInput,
    Title,
} from "@mantine/core";
import { ArrowRightLeft, FolderOpen, HardDrive, RefreshCcw, Search, Wrench } from "lucide-react";
import type { SettingsController } from "../../../hooks/settings/use-settings-controller";
import type { PendingLibraryMove } from "../../../use-cases/change-library-path";
import type { LibraryMigrationProgress } from "../../../types/generated/LibraryMigrationProgress";
import { AppButton } from "../../ui/app-button";
import { displayWindowsPath } from "../../../utils/paths";

// "12.4 GB in 1,204 video files, 33 audio files and 1,250 thumbnails", or null without a summary.
function describeMoveSize(move: PendingLibraryMove): string | null {
    const summary = move.summary;

    if (!summary) {
        return null;
    }

    const count = (value: number, one: string, many: string): string =>
        `${value.toLocaleString()} ${value === 1 ? one : many}`;

    return `${summary.formatted_size} in ${count(summary.video_files, "video file", "video files")}, ${count(summary.audio_files, "audio file", "audio files")} and ${count(summary.thumbnail_files, "thumbnail", "thumbnails")}`;
}

type LibraryMoveProgressProps = {
    progress: LibraryMigrationProgress | null;
    onCancelRunning: () => void;
};

// While the copy runs. By bytes rather than by files, since one video outweighs thousands of
// thumbnails and a file count would sit near the end for most of the time.
function LibraryMoveProgress({ progress, onCancelRunning }: LibraryMoveProgressProps): JSX.Element {
    const percent =
        progress && progress.totalBytes > 0
            ? Math.min(100, (progress.copiedBytes / progress.totalBytes) * 100)
            : 0;

    return (
        <Stack gap="xs">
            <Progress value={percent} aria-label="Library move progress" />
            <Text size="sm" c="dimmed" role="status" aria-live="polite">
                {progress
                    ? `Copied ${progress.copiedFiles.toLocaleString()} of ${progress.totalFiles.toLocaleString()} files`
                    : "Preparing the move..."}
            </Text>
            <Group gap="sm">
                <AppButton appVariant="danger" onClick={onCancelRunning}>
                    Cancel move
                </AppButton>
            </Group>
        </Stack>
    );
}

type PendingLibraryMoveAlertProps = {
    move: PendingLibraryMove;
    isMigratingLibraryPath: boolean;
    progress: LibraryMigrationProgress | null;
    onConfirm: () => void;
    onCancel: () => void;
    onCancelRunning: () => void;
};

function PendingLibraryMoveAlert({
    move,
    isMigratingLibraryPath,
    progress,
    onConfirm,
    onCancel,
    onCancelRunning,
}: PendingLibraryMoveAlertProps): JSX.Element {
    const destination = displayWindowsPath(move.destination);
    const size = describeMoveSize(move);

    if (move.currentFolderUnreachable) {
        return (
            <Alert color="yellow" variant="light">
                <Stack gap="xs">
                    <Text size="sm" fw={600}>
                        The current library folder cannot be reached
                    </Text>
                    <Text size="sm">
                        Kavynex cannot open {displayWindowsPath(move.currentLibraryPath)}, so
                        nothing can be moved from it. If it is on a drive that is not connected,
                        cancel, reconnect the drive and try again. Using {destination} instead
                        moves nothing, and the media already added show as missing until their
                        files are back in the library folder.
                    </Text>
                    <Group gap="sm">
                        <AppButton
                            appVariant="primary"
                            onClick={onConfirm}
                            loading={isMigratingLibraryPath}
                        >
                            Use the new folder anyway
                        </AppButton>
                        <AppButton
                            appVariant="ghost"
                            onClick={onCancel}
                            disabled={isMigratingLibraryPath}
                        >
                            Cancel
                        </AppButton>
                    </Group>
                </Stack>
            </Alert>
        );
    }

    return (
        <Alert color="yellow" variant="light">
            <Stack gap="xs">
                <Text size="sm" fw={600}>
                    Move the library to {destination}?
                </Text>
                <Text size="sm">
                    {size ? `${size} will be copied there. ` : "Every file in the library will be copied there. "}
                    The old folder is removed only after every file is confirmed copied, and
                    adding or deleting media waits until the move is done.
                </Text>
                {isMigratingLibraryPath ? (
                    <LibraryMoveProgress progress={progress} onCancelRunning={onCancelRunning} />
                ) : (
                    <Group gap="sm">
                        <AppButton
                            appVariant="primary"
                            leftSection={<ArrowRightLeft size={16} />}
                            onClick={onConfirm}
                        >
                            Move library
                        </AppButton>
                        <AppButton appVariant="ghost" onClick={onCancel}>
                            Cancel
                        </AppButton>
                    </Group>
                )}
            </Stack>
        </Alert>
    );
}

type LibraryFolderSectionProps = Pick<
    SettingsController,
    | "librarySummary"
    | "isLoadingLibrarySummary"
    | "librarySummaryError"
    | "refreshLibrarySummary"
> & {
    libraryPath: string;
    isLibraryUnreachable?: boolean;
    isRetryingLibraryFolder?: boolean;
    onRetryLibraryFolder?: () => void;
    onChooseLibraryPath: () => void;
    onOpenLibraryPath: () => void;
    onOpenDiagnostics: () => void;
    disableLibraryPathChange: boolean;
    libraryPathChangeDisabledReason: string;
    isMigratingLibraryPath: boolean;
    pendingLibraryMove?: PendingLibraryMove | null;
    onConfirmLibraryMove?: () => void;
    onCancelLibraryMove?: () => void;
    libraryMoveProgress?: LibraryMigrationProgress | null;
    onCancelRunningLibraryMove?: () => void;
};

export function LibraryFolderSection({
    libraryPath,
    isLibraryUnreachable = false,
    isRetryingLibraryFolder = false,
    onRetryLibraryFolder = () => undefined,
    librarySummary,
    isLoadingLibrarySummary,
    librarySummaryError,
    refreshLibrarySummary,
    onChooseLibraryPath,
    onOpenLibraryPath,
    onOpenDiagnostics,
    disableLibraryPathChange,
    libraryPathChangeDisabledReason,
    isMigratingLibraryPath,
    pendingLibraryMove = null,
    onConfirmLibraryMove = () => undefined,
    onCancelLibraryMove = () => undefined,
    libraryMoveProgress = null,
    onCancelRunningLibraryMove = () => undefined,
}: LibraryFolderSectionProps): JSX.Element {
    return (
        <Stack gap="xs">
            <Group gap="sm">
                <HardDrive size={18} />
                <Title order={3} size="h4">Library folder</Title>
            </Group>

            <TextInput
                // Names the field for assistive tech. The visible <Title> above is not
                // programmatically associated with it.
                aria-label="Library folder"
                value={displayWindowsPath(libraryPath)}
                readOnly
                placeholder="No library folder selected"
            />

            {isLibraryUnreachable && (
                <Alert color="yellow" variant="light">
                    <Stack gap="xs">
                        <Text size="sm" fw={600}>
                            The library folder cannot be reached
                        </Text>
                        <Text size="sm">
                            Kavynex cannot open this folder. If it is on a drive that is not
                            connected, connect it and try again. It is still your library folder,
                            and nothing in it or in the app was changed. Choosing another folder
                            asks first and moves nothing.
                        </Text>
                        <Group gap="sm">
                            <AppButton
                                appVariant="primary"
                                leftSection={<RefreshCcw size={16} />}
                                onClick={onRetryLibraryFolder}
                                loading={isRetryingLibraryFolder}
                                disabled={disableLibraryPathChange}
                            >
                                Try again
                            </AppButton>
                        </Group>
                    </Stack>
                </Alert>
            )}

            {!libraryPath.trim() && (
                <Alert color="blue" variant="light">
                    <Text size="sm">
                        Configure a library folder to enable disk usage, file counters and
                        diagnostics based on the physical library.
                    </Text>
                </Alert>
            )}

            <Group justify="space-between" align="center">
                <Text size="sm" c="dimmed">
                    Library summary
                </Text>

                <AppButton
                    appVariant="ghost"
                    size="xs"
                    leftSection={<RefreshCcw size={14} />}
                    onClick={() => {
                        void refreshLibrarySummary();
                    }}
                    disabled={!libraryPath.trim()}
                    loading={isLoadingLibrarySummary}
                >
                    Refresh
                </AppButton>
            </Group>

            <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
                <Paper withBorder radius="md" p="sm">
                    <Stack gap={2}>
                        <Text size="xs" c="dimmed">
                            Disk usage
                        </Text>
                        <Text fw={700}>
                            {isLoadingLibrarySummary
                                ? "Calculating..."
                                : librarySummary.formatted_size}
                        </Text>
                    </Stack>
                </Paper>

                <Paper withBorder radius="md" p="sm">
                    <Stack gap={2}>
                        <Text size="xs" c="dimmed">
                            Video files
                        </Text>
                        <Text fw={700}>
                            {isLoadingLibrarySummary
                                ? "-"
                                : librarySummary.video_files.toLocaleString()}
                        </Text>
                    </Stack>
                </Paper>

                <Paper withBorder radius="md" p="sm">
                    <Stack gap={2}>
                        <Text size="xs" c="dimmed">
                            Audio files
                        </Text>
                        <Text fw={700}>
                            {isLoadingLibrarySummary
                                ? "-"
                                : librarySummary.audio_files.toLocaleString()}
                        </Text>
                    </Stack>
                </Paper>

                <Paper withBorder radius="md" p="sm">
                    <Stack gap={2}>
                        <Text size="xs" c="dimmed">
                            Thumbnails
                        </Text>
                        <Text fw={700}>
                            {isLoadingLibrarySummary
                                ? "-"
                                : librarySummary.thumbnail_files.toLocaleString()}
                        </Text>
                    </Stack>
                </Paper>
            </SimpleGrid>

            {!!librarySummaryError && (
                <Alert color="yellow" variant="light" role="status" aria-live="polite">
                    <Text size="sm">{librarySummaryError}</Text>
                </Alert>
            )}

            <Group gap="sm">
                {/* Secondary, like Open folder and Diagnostics beside it. As the one
                    filled button in the modal it read as the thing Settings is for,
                    which it is not. Most people set the folder once. */}
                <AppButton
                    appVariant="secondary"
                    leftSection={<Search size={16} />}
                    onClick={onChooseLibraryPath}
                    disabled={disableLibraryPathChange || pendingLibraryMove !== null}
                    loading={isMigratingLibraryPath && pendingLibraryMove === null}
                >
                    Choose folder
                </AppButton>

                <AppButton
                    appVariant="secondary"
                    leftSection={<FolderOpen size={16} />}
                    onClick={onOpenLibraryPath}
                    disabled={!libraryPath.trim() || isLibraryUnreachable}
                >
                    Open folder
                </AppButton>

                <AppButton
                    appVariant="secondary"
                    leftSection={<Wrench size={16} />}
                    onClick={onOpenDiagnostics}
                >
                    Diagnostics
                </AppButton>
            </Group>

            {pendingLibraryMove && (
                <PendingLibraryMoveAlert
                    move={pendingLibraryMove}
                    isMigratingLibraryPath={isMigratingLibraryPath}
                    progress={libraryMoveProgress}
                    onConfirm={onConfirmLibraryMove}
                    onCancel={onCancelLibraryMove}
                    onCancelRunning={onCancelRunningLibraryMove}
                />
            )}

            {disableLibraryPathChange && libraryPathChangeDisabledReason && (
                <Alert color="yellow" variant="light">
                    <Text size="sm">{libraryPathChangeDisabledReason}</Text>
                </Alert>
            )}
        </Stack>
    );
}
