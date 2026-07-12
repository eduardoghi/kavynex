import { Modal, Stack } from "@mantine/core";
import { useSettingsController } from "../../hooks/use-settings-controller";
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
    const controller = useSettingsController({ opened, libraryPath });

    return (
        <Modal opened={opened} onClose={onClose} title="Settings" size="lg" centered>
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
                />

                <AppUpdateSection
                    appUpdateStatus={controller.appUpdateStatus}
                    updateInfo={controller.updateInfo}
                    appUpdateProgress={controller.appUpdateProgress}
                    appUpdateErrorMessage={controller.appUpdateErrorMessage}
                    checkForUpdate={controller.checkForUpdate}
                    installUpdate={controller.installUpdate}
                />
            </Stack>
        </Modal>
    );
}
