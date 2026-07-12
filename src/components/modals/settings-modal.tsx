import {
    Alert,
    Group,
    Modal,
    Paper,
    Progress,
    Radio,
    SimpleGrid,
    Stack,
    Switch,
    Text,
    TextInput,
    Title,
} from "@mantine/core";
import {
    Database,
    Download,
    FolderOpen,
    HardDrive,
    RefreshCcw,
    Search,
    Settings2,
    Shield,
    Undo2,
    Upload,
    Wrench,
} from "lucide-react";
import { useSettingsController } from "../../hooks/use-settings-controller";
import type { ImportMode } from "../../types/settings";
import { AppButton } from "../ui/app-button";

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

type SettingsModalProps = {
    opened: boolean;
    onClose: () => void;
    importMode: ImportMode;
    libraryPath: string;
    loadRemoteImages: boolean;
    onChangeImportMode: (mode: ImportMode) => void;
    onChangeLoadRemoteImages: (loadRemoteImages: boolean) => void;
    onChooseLibraryPath: () => void;
    onOpenLibraryPath: () => void;
    onOpenDiagnostics: () => void;
    disableLibraryPathChange: boolean;
    libraryPathChangeDisabledReason: string;
    isMigratingLibraryPath: boolean;
};

export function SettingsModal({
    opened,
    onClose,
    importMode,
    libraryPath,
    loadRemoteImages,
    onChangeImportMode,
    onChangeLoadRemoteImages,
    onChooseLibraryPath,
    onOpenLibraryPath,
    onOpenDiagnostics,
    disableLibraryPathChange,
    libraryPathChangeDisabledReason,
    isMigratingLibraryPath,
}: SettingsModalProps): JSX.Element {
    const {
        librarySummary,
        isLoadingLibrarySummary,
        librarySummaryError,
        refreshLibrarySummary,
        databaseBusy,
        databaseMessage,
        pendingImportPath,
        exportDatabaseAction,
        pickImportFileAction,
        confirmImportAction,
        cancelImport,
        canUndoImport,
        isUndoImportConfirmOpen,
        requestUndoImport,
        cancelUndoImport,
        confirmUndoImportAction,
        appUpdateStatus,
        updateInfo,
        appUpdateProgress,
        appUpdateErrorMessage,
        checkForUpdate,
        installUpdate,
    } = useSettingsController({ opened, libraryPath });

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title="Settings"
            size="lg"
            centered
        >
            <Stack gap="lg">
                <Stack gap="xs">
                    <Group gap="sm">
                        <Settings2 size={18} />
                        <Title order={4}>Import behavior</Title>
                    </Group>

                    <Radio.Group
                        value={importMode}
                        onChange={(value) => onChangeImportMode(value as ImportMode)}
                    >
                        <Stack gap="xs">
                            <Radio
                                value="copy"
                                label="Copy files into the library folder"
                                disabled={isMigratingLibraryPath}
                            />

                            <Radio
                                value="move"
                                label="Move files into the library folder"
                                disabled={isMigratingLibraryPath}
                            />
                        </Stack>
                    </Radio.Group>
                </Stack>

                <Stack gap="xs">
                    <Group gap="sm">
                        <Shield size={18} />
                        <Title order={4}>Privacy</Title>
                    </Group>

                    <Switch
                        checked={loadRemoteImages}
                        onChange={(event) =>
                            onChangeLoadRemoteImages(event.currentTarget.checked)
                        }
                        label="Load comment and live chat images from Google"
                        description="When on, author avatars, custom emojis and super-sticker images are fetched from Google's servers as you open saved comments and live chat. Turn off to show monograms and hide those images so viewing saved media stays fully offline."
                    />
                </Stack>

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

                <Stack gap="xs">
                    <Group gap="sm">
                        <Database size={18} />
                        <Title order={4}>Database</Title>
                    </Group>

                    <Paper withBorder radius="md" p="sm">
                        <Stack gap="sm">
                            <Text size="sm" c="dimmed">
                                Export a portable copy of your library database (channels, media,
                                comments and watch history) to keep off-machine or move to another
                                install, or import one to restore it. Media files live in the
                                library folder and are backed up separately.
                            </Text>

                            <Group gap="sm">
                                <AppButton
                                    appVariant="secondary"
                                    leftSection={<Download size={16} />}
                                    onClick={() => {
                                        void exportDatabaseAction();
                                    }}
                                    loading={databaseBusy === "exporting"}
                                    disabled={databaseBusy !== "idle"}
                                >
                                    Export database
                                </AppButton>

                                <AppButton
                                    appVariant="secondary"
                                    leftSection={<Upload size={16} />}
                                    onClick={() => {
                                        void pickImportFileAction();
                                    }}
                                    disabled={databaseBusy !== "idle"}
                                >
                                    Import database
                                </AppButton>

                                {canUndoImport && (
                                    <AppButton
                                        appVariant="ghost"
                                        leftSection={<Undo2 size={16} />}
                                        onClick={requestUndoImport}
                                        disabled={
                                            databaseBusy !== "idle" || Boolean(pendingImportPath)
                                        }
                                    >
                                        Undo last import
                                    </AppButton>
                                )}
                            </Group>

                            {isUndoImportConfirmOpen && (
                                <Alert color="yellow" variant="light">
                                    <Stack gap="xs">
                                        <Text size="sm" fw={600}>
                                            Undo the last database import?
                                        </Text>
                                        <Text size="sm">
                                            This restores the database from just before your last
                                            import and restarts the app. Any changes made since that
                                            import will be lost. Your media files are not affected.
                                        </Text>
                                        <Group gap="sm">
                                            <AppButton
                                                appVariant="primary"
                                                leftSection={<Undo2 size={16} />}
                                                onClick={() => {
                                                    void confirmUndoImportAction();
                                                }}
                                                loading={databaseBusy === "undoing"}
                                            >
                                                Undo and restart
                                            </AppButton>
                                            <AppButton
                                                appVariant="ghost"
                                                onClick={cancelUndoImport}
                                                disabled={databaseBusy === "undoing"}
                                            >
                                                Cancel
                                            </AppButton>
                                        </Group>
                                    </Stack>
                                </Alert>
                            )}

                            {pendingImportPath && (
                                <Alert color="yellow" variant="light">
                                    <Stack gap="xs">
                                        <Text size="sm" fw={600}>
                                            Replace the current database?
                                        </Text>
                                        <Text size="sm">
                                            Importing replaces your current library database and
                                            restarts the app. Your current database is kept as a
                                            safety copy. Make sure this machine's library folder
                                            matches the imported data.
                                        </Text>
                                        <Group gap="sm">
                                            <AppButton
                                                appVariant="primary"
                                                leftSection={<Upload size={16} />}
                                                onClick={() => {
                                                    void confirmImportAction();
                                                }}
                                                loading={databaseBusy === "importing"}
                                            >
                                                Replace and restart
                                            </AppButton>
                                            <AppButton
                                                appVariant="ghost"
                                                onClick={cancelImport}
                                                disabled={databaseBusy === "importing"}
                                            >
                                                Cancel
                                            </AppButton>
                                        </Group>
                                    </Stack>
                                </Alert>
                            )}

                            {databaseMessage && (
                                <Alert
                                    color={databaseMessage.tone === "success" ? "green" : "red"}
                                    variant="light"
                                    role={databaseMessage.tone === "success" ? "status" : "alert"}
                                    aria-live={
                                        databaseMessage.tone === "success" ? "polite" : "assertive"
                                    }
                                >
                                    <Text size="sm">{databaseMessage.text}</Text>
                                </Alert>
                            )}
                        </Stack>
                    </Paper>
                </Stack>

                <Stack gap="xs">
                    <Group gap="sm">
                        <RefreshCcw size={18} />
                        <Title order={4}>Application update</Title>
                    </Group>

                    <Paper withBorder radius="md" p="sm">
                        <Stack gap="sm">
                            <Group justify="space-between" align="flex-start">
                                <Stack gap={2}>
                                    <Text fw={600}>Kavynex updates</Text>
                                    <Text size="sm" c="dimmed">
                                        Check GitHub Releases for a newer version of the app.
                                    </Text>
                                </Stack>

                                <AppButton
                                    appVariant="secondary"
                                    size="xs"
                                    leftSection={<RefreshCcw size={14} />}
                                    onClick={() => {
                                        void checkForUpdate();
                                    }}
                                    loading={appUpdateStatus === "checking"}
                                    disabled={appUpdateStatus === "downloading"}
                                >
                                    Check update
                                </AppButton>
                            </Group>

                            {appUpdateStatus === "not-available" && (
                                <Alert color="green" variant="light" role="status" aria-live="polite">
                                    <Text size="sm">Kavynex is already up to date.</Text>
                                </Alert>
                            )}

                            {updateInfo && (
                                <Alert color="blue" variant="light" role="status" aria-live="polite">
                                    <Stack gap="xs">
                                        <Text fw={600}>
                                            Version {updateInfo.version} is available.
                                        </Text>

                                        <Text size="sm">
                                            Current version: {updateInfo.currentVersion}
                                        </Text>

                                        {!!updateInfo.body && (
                                            <Text size="sm" c="dimmed">
                                                {updateInfo.body}
                                            </Text>
                                        )}

                                        {appUpdateStatus === "downloading" && (
                                            <Stack gap={4}>
                                                <Progress value={appUpdateProgress?.percent ?? 0} />
                                                <Text size="xs" c="dimmed">
                                                    {appUpdateProgress?.percent ?? 0}% downloaded
                                                </Text>
                                            </Stack>
                                        )}

                                        <Group>
                                            <AppButton
                                                appVariant="primary"
                                                leftSection={<Download size={16} />}
                                                onClick={() => {
                                                    void installUpdate();
                                                }}
                                                loading={appUpdateStatus === "downloading"}
                                                disabled={appUpdateStatus === "downloading"}
                                            >
                                                Download and install
                                            </AppButton>
                                        </Group>
                                    </Stack>
                                </Alert>
                            )}

                            {!!appUpdateErrorMessage && (
                                <Alert color="red" variant="light" role="alert" aria-live="assertive">
                                    <Text size="sm">{appUpdateErrorMessage}</Text>
                                </Alert>
                            )}
                        </Stack>
                    </Paper>
                </Stack>
            </Stack>
        </Modal>
    );
}