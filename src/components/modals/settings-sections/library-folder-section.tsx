import { Alert, Group, Paper, SimpleGrid, Stack, Text, TextInput, Title } from "@mantine/core";
import { FolderOpen, HardDrive, RefreshCcw, Search, Wrench } from "lucide-react";
import type { SettingsController } from "../../../hooks/use-settings-controller";
import { AppButton } from "../../ui/app-button";

// Windows extended-length paths (`\\?\`, `\\?\UNC\`) are what the backend canonicalizes to, but
// they are noise to a user, so the raw stored path is prettied only for display.
function displayWindowsPath(path: string): string {
    const normalizedPath = path.trim();

    if (normalizedPath.startsWith("\\\\?\\UNC\\")) {
        return `\\\\${normalizedPath.slice(8)}`;
    }

    if (normalizedPath.startsWith("\\\\?\\")) {
        return normalizedPath.slice(4);
    }

    return normalizedPath;
}

type LibraryFolderSectionProps = Pick<
    SettingsController,
    | "librarySummary"
    | "isLoadingLibrarySummary"
    | "librarySummaryError"
    | "refreshLibrarySummary"
> & {
    libraryPath: string;
    onChooseLibraryPath: () => void;
    onOpenLibraryPath: () => void;
    onOpenDiagnostics: () => void;
    disableLibraryPathChange: boolean;
    libraryPathChangeDisabledReason: string;
    isMigratingLibraryPath: boolean;
};

export function LibraryFolderSection({
    libraryPath,
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
}: LibraryFolderSectionProps): JSX.Element {
    return (
        <Stack gap="xs">
            <Group gap="sm">
                <HardDrive size={18} />
                <Title order={4}>Library folder</Title>
            </Group>

            <TextInput
                value={displayWindowsPath(libraryPath)}
                readOnly
                placeholder="No library folder selected"
            />

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
                                ? "—"
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
                                ? "—"
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
                                ? "—"
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
                <AppButton
                    appVariant="primary"
                    leftSection={<Search size={16} />}
                    onClick={onChooseLibraryPath}
                    disabled={disableLibraryPathChange}
                    loading={isMigratingLibraryPath}
                >
                    Choose folder
                </AppButton>

                <AppButton
                    appVariant="secondary"
                    leftSection={<FolderOpen size={16} />}
                    onClick={onOpenLibraryPath}
                    disabled={!libraryPath.trim()}
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

            {disableLibraryPathChange && libraryPathChangeDisabledReason && (
                <Alert color="yellow" variant="light">
                    <Text size="sm">{libraryPathChangeDisabledReason}</Text>
                </Alert>
            )}
        </Stack>
    );
}
