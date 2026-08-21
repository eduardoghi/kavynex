import { Alert, Divider, Group, Stack, Text, Title } from "@mantine/core";
import { Database, Download, FolderClock, Undo2, Upload, X } from "lucide-react";
import type { SettingsController } from "../../../hooks/settings/use-settings-controller";
import { AppButton } from "../../ui/app-button";

// "the backup from <date>" in the recovery modal uses the same locale call. Keep them reading the
// same way. A status with no backup yet has no timestamp, which the caller renders as its own line
// rather than passing here.
function formatBackedUpAt(backedUpAtMs: number): string {
    return new Date(backedUpAtMs).toLocaleString("en-US");
}

type DatabaseSectionProps = Pick<
    SettingsController,
    | "backupStatus"
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
    backupStatus,
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

    // The two halves of this section used to sit in their own bordered cards, inside a modal that
    // is already a card, under a heading that already groups them. Import behavior and Privacy
    // carry no card at all, so the borders were making Database look like a different kind of
    // thing rather than marking anything. A divider is enough to say where the backup half starts.
    return (
        <Stack gap="xs">
            <Group gap="sm">
                <Database size={18} />
                <Title order={4}>Database</Title>
            </Group>

            <Text size="sm" c="dimmed">
                A portable copy of your channels, media, comments and watch history. Media files
                live in the library folder and are not included.
            </Text>

            {backupStatus && (
                <Text size="sm" c="dimmed">
                    {backupStatus.backedUpAtMs === null
                        ? "No automatic backup yet."
                        : `Last automatic backup: ${formatBackedUpAt(backupStatus.backedUpAtMs)}.`}{" "}
                    {/* The size is shown because nothing else surfaces it: Kavynex keeps several
                        rotated snapshots beside the database, so this folder can hold many times
                        the database's own size without anything saying so. Named "on this disk"
                        rather than "backups" because the total includes the live database. */}
                    Database and backups use{" "}
                    <Text span fw={600}>
                        {backupStatus.formattedTotalSize}
                    </Text>{" "}
                    on this disk.
                </Text>
            )}

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
                            This restores the database from just before your last import and
                            restarts the app. Any changes made since that import will be lost.
                            Your media files are not affected.
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
                            Importing replaces your current library database and restarts the app.
                            Your current database is kept as a safety copy. Make sure this
                            machine's library folder matches the imported data.
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
                    aria-live={databaseMessage.tone === "success" ? "polite" : "assertive"}
                >
                    <Text size="sm">{databaseMessage.text}</Text>
                </Alert>
            )}

            <Divider my={4} />

            <Group gap="sm">
                <FolderClock size={18} />
                <Title order={4}>External database backup</Title>
            </Group>

            <Text size="sm" c="dimmed">
                Automatically copies the database to another drive or network folder once a day.
                Media files are not included.
            </Text>

            {/* A read-only TextInput read as a field you could type a path into, and its empty
                state spent a whole sentence saying the feature was off. Plain text on the section
                background is unmistakably a status, and it still shows the path once there is one
                to show. */}
            <Group gap="xs" wrap="nowrap" align="baseline">
                <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
                    External folder
                </Text>

                <Text
                    size="sm"
                    fw={externalBackupDir ? 600 : 400}
                    c={externalBackupDir ? undefined : "dimmed"}
                    style={{ minWidth: 0, wordBreak: "break-all" }}
                >
                    {externalBackupDir || "Not configured"}
                </Text>
            </Group>

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
    );
}
