import { Alert, Code, Divider, Group, Stack, Text, Title } from "@mantine/core";
import { useEffect, useRef } from "react";
import { Database, Download, FolderClock, Undo2, Upload, X } from "lucide-react";
import type { SettingsController } from "../../../hooks/settings/use-settings-controller";
import { AppButton } from "../../ui/app-button";
import { fileNameFromPath } from "../../../utils/media-utils";

// "the backup from <date>" in the recovery modal uses the same locale call. Keep them reading the
// same way. A status with no backup yet has no timestamp, which the caller renders as its own line
// rather than passing here.
function formatBackedUpAt(backedUpAtMs: number): string {
    return new Date(backedUpAtMs).toLocaleString("en-US");
}

// A mirror older than this is called out. The copy runs once a day while the app is open, so a few
// days without one means the folder has been unreachable or the app has not run.
const STALE_MIRROR_MS = 3 * 24 * 60 * 60 * 1000;

function ExternalBackupStatusLine({
    status,
}: {
    status: NonNullable<SettingsController["externalBackupStatus"]>;
}): JSX.Element {
    if (!status.reachable) {
        return (
            <Text size="sm" c="yellow.7">
                The folder cannot be reached right now, so no copy is being made. Connect the drive or
                the network share, or choose another folder.
            </Text>
        );
    }

    if (status.mirroredAtMs === null) {
        return (
            <Text size="sm" c="dimmed">
                No copy yet. The first one is made within a minute of the app starting.
            </Text>
        );
    }

    const isStale = Date.now() - status.mirroredAtMs > STALE_MIRROR_MS;

    return (
        <Text size="sm" c={isStale ? "yellow.7" : "dimmed"}>
            Last copy: {formatBackedUpAt(status.mirroredAtMs)}.
            {isStale && " That is more than three days ago."}
        </Text>
    );
}

type DatabaseSectionProps = Pick<
    SettingsController,
    | "backupStatus"
    | "externalBackupStatus"
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
    // Why an import or its undo cannot run now (both relaunch the app), or null when they can.
    swapBlockedReason?: string | null;
    externalBackupDir: string;
    isSavingExternalBackupDir: boolean;
    onChooseExternalBackupDir: () => void;
    onClearExternalBackupDir: () => void;
};

export function DatabaseSection({
    swapBlockedReason = null,
    backupStatus,
    externalBackupStatus,
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
    // The confirmations appear below the buttons that opened them. Moving focus there is what lets a
    // keyboard or screen reader user find the question at all, and read which file is about to
    // replace the database before confirming.
    const importConfirmRef = useRef<HTMLDivElement>(null);
    const undoConfirmRef = useRef<HTMLDivElement>(null);
    // And back to the button on Cancel. The confirmation goes away with the focus inside it, which
    // otherwise dropped to the page.
    const importButtonRef = useRef<HTMLButtonElement>(null);
    const undoButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (pendingImportPath) {
            importConfirmRef.current?.focus();
        }
    }, [pendingImportPath]);

    useEffect(() => {
        if (isUndoImportConfirmOpen) {
            undoConfirmRef.current?.focus();
        }
    }, [isUndoImportConfirmOpen]);

    const isBusy = databaseBusy !== "idle";

    // The two halves of this section used to sit in their own bordered cards, inside a modal that
    // is already a card, under a heading that already groups them. Import behavior and Privacy
    // carry no card at all, so the borders were making Database look like a different kind of
    // thing rather than marking anything. A divider is enough to say where the backup half starts.
    return (
        <Stack gap="xs">
            <Group gap="sm">
                <Database size={18} />
                <Title order={3} size="h4">Database</Title>
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
                    ref={importButtonRef}
                    appVariant="secondary"
                    leftSection={<Upload size={16} />}
                    onClick={() => {
                        void pickImportFileAction();
                    }}
                    disabled={databaseBusy !== "idle" || !!swapBlockedReason}
                >
                    Import database
                </AppButton>

                {canUndoImport && (
                    <AppButton
                        ref={undoButtonRef}
                        appVariant="ghost"
                        leftSection={<Undo2 size={16} />}
                        onClick={requestUndoImport}
                        disabled={
                            databaseBusy !== "idle" ||
                            Boolean(pendingImportPath) ||
                            !!swapBlockedReason
                        }
                    >
                        Undo last import
                    </AppButton>
                )}
            </Group>

            {swapBlockedReason && (
                <Text size="xs" c="dimmed">
                    {swapBlockedReason}
                </Text>
            )}

            {isUndoImportConfirmOpen && (
                <Alert
                    ref={undoConfirmRef}
                    tabIndex={-1}
                    color="yellow"
                    variant="light"
                    aria-label="Undo the last database import"
                >
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
                                disabled={!!swapBlockedReason}
                            >
                                Undo and restart
                            </AppButton>
                            <AppButton
                                appVariant="ghost"
                                onClick={() => {
                                    cancelUndoImport();
                                    undoButtonRef.current?.focus();
                                }}
                                disabled={databaseBusy === "undoing"}
                            >
                                Cancel
                            </AppButton>
                        </Group>
                    </Stack>
                </Alert>
            )}

            {pendingImportPath && (
                <Alert
                    ref={importConfirmRef}
                    tabIndex={-1}
                    color="yellow"
                    variant="light"
                    aria-label="Replace the current database"
                >
                    <Stack gap="xs">
                        <Text size="sm" fw={600}>
                            Replace the current database?
                        </Text>
                        <Text size="sm" title={pendingImportPath}>
                            Selected file: <Code>{fileNameFromPath(pendingImportPath)}</Code>
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
                                disabled={!!swapBlockedReason}
                            >
                                Replace and restart
                            </AppButton>
                            <AppButton
                                appVariant="ghost"
                                onClick={() => {
                                    cancelImport();
                                    importButtonRef.current?.focus();
                                }}
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
                <Title order={3} size="h4">External database backup</Title>
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

            {externalBackupDir && externalBackupStatus?.configured && (
                <ExternalBackupStatusLine status={externalBackupStatus} />
            )}

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
