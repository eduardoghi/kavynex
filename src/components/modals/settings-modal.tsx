import { Modal, Stack } from "@mantine/core";
import { useSettingsController } from "../../hooks/use-settings-controller";
import type { ImportMode } from "../../types/settings";
import { NOOP } from "../../utils/noop";
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
    // operation or a library migration is in progress, so the user cannot dismiss it mid-flight
    // and lose visibility into an error, or trigger an app relaunch behind a closed modal.
    const isModalLocked = controller.databaseBusy !== "idle" || isMigratingLibraryPath;

    return (
        <Modal
            opened={opened}
            onClose={isModalLocked ? NOOP : onClose}
            title="Settings"
            size="lg"
            centered
            closeOnClickOutside={!isModalLocked}
            closeOnEscape={!isModalLocked}
            withCloseButton={!isModalLocked}
        >
            <Stack gap="lg">
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
        </Modal>
    );
}
