import { Alert, Group, Paper, Stack, Text, TextInput, Title } from "@mantine/core";
import { Database, Download, FolderClock, Undo2, Upload, X } from "lucide-react";
import type { SettingsController } from "../../../hooks/use-settings-controller";
import { AppButton } from "../../ui/app-button";

type DatabaseSectionProps = Pick<
    SettingsController,
    | "databaseBusy"
    | "databaseMessage"
    | "pendingImportPath"
    | "exportDatabaseAction"
    | "pickImportFileAction"
    | "confirmImportAction"
    | "cancelImport"
    | "canUndoImport"
    | "isUndoImportConfirmOpen"
    | "requestUndoImport"
    | "cancelUndoImport"
    | "confirmUndoImportAction"
> & {
    externalBackupDir: string;
    isSavingExternalBackupDir: boolean;
    onChooseExternalBackupDir: () => void;
    onClearExternalBackupDir: () => void;
};

export function DatabaseSection({
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
    externalBackupDir,
    isSavingExternalBackupDir,
    onChooseExternalBackupDir,
    onClearExternalBackupDir,
}: DatabaseSectionProps): JSX.Element {
    const isBusy = databaseBusy !== "idle";

    return (
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
                        install, or import one to restore it. Media files live in the library
                        folder and are backed up separately.
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
                                disabled={databaseBusy !== "idle" || Boolean(pendingImportPath)}
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
                                    This restores the database from just before your last import
                                    and restarts the app. Any changes made since that import will
                                    be lost. Your media files are not affected.
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
                                    Importing replaces your current library database and restarts
                                    the app. Your current database is kept as a safety copy. Make
                                    sure this machine's library folder matches the imported data.
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

            <Paper withBorder radius="md" p="sm">
                <Stack gap="sm">
                    <Group gap="sm">
                        <FolderClock size={16} />
                        <Text size="sm" fw={600}>
                            Automatic external backup
                        </Text>
                    </Group>

                    <Text size="sm" c="dimmed">
                        The automatic backups above live next to the database, on the same disk, so
                        a drive failure takes them with it. Choose an external folder (another drive
                        or a network share) and Kavynex copies the database there once a day. Only
                        the database is copied; back up the library folder separately.
                    </Text>

                    <TextInput
                        label="External backup folder"
                        value={externalBackupDir}
                        readOnly
                        placeholder="Off - no external backup folder selected"
                    />

                    <Group gap="sm">
                        <AppButton
                            appVariant="secondary"
                            leftSection={<FolderClock size={16} />}
                            onClick={onChooseExternalBackupDir}
                            loading={isSavingExternalBackupDir}
                            disabled={isBusy}
                        >
                            {externalBackupDir ? "Change backup folder" : "Choose backup folder"}
                        </AppButton>

                        {externalBackupDir && (
                            <AppButton
                                appVariant="ghost"
                                leftSection={<X size={16} />}
                                onClick={onClearExternalBackupDir}
                                disabled={isBusy || isSavingExternalBackupDir}
                            >
                                Turn off
                            </AppButton>
                        )}
                    </Group>
                </Stack>
            </Paper>
        </Stack>
    );
}
