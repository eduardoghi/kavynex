import { Modal, ScrollArea, Stack } from "@mantine/core";
import { useSettingsController } from "../../hooks/use-settings-controller";
import { useModalLock } from "../../hooks/use-modal-lock";
import type { ImportMode } from "../../types/settings";
import { AppUpdateSection } from "./settings-sections/app-update-section";
import { DatabaseSection } from "./settings-sections/database-section";
import { ImportBehaviorSection } from "./settings-sections/import-behavior-section";
import { LibraryFolderSection } from "./settings-sections/library-folder-section";
import { PrivacySection } from "./settings-sections/privacy-section";

type SettingsModalProps = {
    opened: boolean;
    onClose: () => void;
    importMode: ImportMode;
    libraryPath: string;
    loadRemoteImages: boolean;
    checkUpdatesOnStartup: boolean;
    onChangeImportMode: (mode: ImportMode) => void;
    onChangeLoadRemoteImages: (loadRemoteImages: boolean) => void;
    onChangeCheckUpdatesOnStartup: (checkUpdatesOnStartup: boolean) => void;
    onChooseLibraryPath: () => void;
    onOpenLibraryPath: () => void;
    onOpenDiagnostics: () => void;
    disableLibraryPathChange: boolean;
    libraryPathChangeDisabledReason: string;
    isMigratingLibraryPath: boolean;
    externalBackupDir: string;
    isSavingExternalBackupDir: boolean;
    onChooseExternalBackupDir: () => void;
    onClearExternalBackupDir: () => void;
};

export function SettingsModal({
    opened,
    onClose,
    importMode,
    libraryPath,
    loadRemoteImages,
    checkUpdatesOnStartup,
    onChangeImportMode,
    onChangeLoadRemoteImages,
    onChangeCheckUpdatesOnStartup,
    onChooseLibraryPath,
    onOpenLibraryPath,
    onOpenDiagnostics,
    disableLibraryPathChange,
    libraryPathChangeDisabledReason,
    isMigratingLibraryPath,
    externalBackupDir,
    isSavingExternalBackupDir,
    onChooseExternalBackupDir,
    onClearExternalBackupDir,
}: SettingsModalProps): JSX.Element {
    const controller = useSettingsController({ opened, libraryPath });

    // Locks the modal (no Esc, click-outside or close button) while a destructive database
    // operation, a library migration, or an app update check/download is in progress, so the user
    // cannot dismiss it mid-flight and lose visibility into an error - or, for the update, close the
    // modal and keep working only for installAppUpdate to relaunch the whole app by surprise when
    // the download finishes. Keeping the modal open until the update resolves means the relaunch is
    // never a surprise.
    const isUpdateInProgress =
        controller.appUpdateStatus === "checking" ||
        controller.appUpdateStatus === "downloading";
    const isModalLocked =
        controller.databaseBusy !== "idle" || isMigratingLibraryPath || isUpdateInProgress;

    const modalLock = useModalLock(isModalLocked, onClose);

    return (
        <Modal
            opened={opened}
            {...modalLock}
            title="Settings"
            size="lg"
            centered
            // Cap the modal to the viewport and scroll the body *inside* it, mirroring the
            // diagnostics modal. Without a bounded height the whole viewport-height wrapper scrolls,
            // so the scrollbar lands at the window edge; and a scrollbar flush to the content box is
            // clipped by the modal's rounded (radius "xl") corners. A fixed-height flex column with
            // an offset-scrollbar ScrollArea keeps the header fixed and the scrollbar inset from the
            // corners.
            styles={{
                content: {
                    height: "min(88vh, 860px)",
                    display: "flex",
                    flexDirection: "column",
                },
                body: {
                    flex: 1,
                    minHeight: 0,
                    overflow: "hidden",
                },
            }}
        >
            <ScrollArea h="100%" offsetScrollbars scrollbarSize={10} type="scroll">
                <Stack gap="lg" pr="xs">
                    <ImportBehaviorSection
                        importMode={importMode}
                        onChangeImportMode={onChangeImportMode}
                        isMigratingLibraryPath={isMigratingLibraryPath}
                    />

                    <PrivacySection
                        loadRemoteImages={loadRemoteImages}
                        onChangeLoadRemoteImages={onChangeLoadRemoteImages}
                    />

                    <LibraryFolderSection
                        libraryPath={libraryPath}
                        librarySummary={controller.librarySummary}
                        isLoadingLibrarySummary={controller.isLoadingLibrarySummary}
                        librarySummaryError={controller.librarySummaryError}
                        refreshLibrarySummary={controller.refreshLibrarySummary}
                        onChooseLibraryPath={onChooseLibraryPath}
                        onOpenLibraryPath={onOpenLibraryPath}
                        onOpenDiagnostics={onOpenDiagnostics}
                        disableLibraryPathChange={disableLibraryPathChange}
                        libraryPathChangeDisabledReason={libraryPathChangeDisabledReason}
                        isMigratingLibraryPath={isMigratingLibraryPath}
                    />

                    <DatabaseSection
                        databaseBusy={controller.databaseBusy}
                        databaseMessage={controller.databaseMessage}
                        pendingImportPath={controller.pendingImportPath}
                        exportDatabaseAction={controller.exportDatabaseAction}
                        pickImportFileAction={controller.pickImportFileAction}
                        confirmImportAction={controller.confirmImportAction}
                        cancelImport={controller.cancelImport}
                        canUndoImport={controller.canUndoImport}
                        isUndoImportConfirmOpen={controller.isUndoImportConfirmOpen}
                        requestUndoImport={controller.requestUndoImport}
                        cancelUndoImport={controller.cancelUndoImport}
                        confirmUndoImportAction={controller.confirmUndoImportAction}
                        externalBackupDir={externalBackupDir}
                        isSavingExternalBackupDir={isSavingExternalBackupDir}
                        onChooseExternalBackupDir={onChooseExternalBackupDir}
                        onClearExternalBackupDir={onClearExternalBackupDir}
                    />

                    <AppUpdateSection
                        appUpdateStatus={controller.appUpdateStatus}
                        updateInfo={controller.updateInfo}
                        appUpdateProgress={controller.appUpdateProgress}
                        appUpdateErrorMessage={controller.appUpdateErrorMessage}
                        checkForUpdate={controller.checkForUpdate}
                        installUpdate={controller.installUpdate}
                        checkUpdatesOnStartup={checkUpdatesOnStartup}
                        onChangeCheckUpdatesOnStartup={onChangeCheckUpdatesOnStartup}
                    />
                </Stack>
            </ScrollArea>
        </Modal>
    );
}
