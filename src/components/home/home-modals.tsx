import { Text } from "@mantine/core";
import { RotateCcw } from "lucide-react";
import { AddMediaModal } from "../modals/add-media-modal";
import { ConfirmDeleteModal } from "../modals/confirm-delete-modal";
import { CreateChannelModal } from "../modals/create-channel-modal";
import { DiagnosticsModal } from "../modals/diagnostics-modal";
import { ErrorModal } from "../modals/error-modal";
import { SettingsModal } from "../modals/settings-modal";
import type {
    AppSettingsController,
    ChannelsController,
    DatabaseRecoveryController,
    DiagnosticsController,
    ErrorModalController,
    HomeMediaActionsController,
    HomeUiGuardsController,
    MediaLibraryController,
} from "../../types/controllers";
import type { DiagnosticsMediaTarget } from "../../types/diagnostics";

type HomeModalsProps = {
    channels: ChannelsController;
    media: MediaLibraryController;
    mediaActions: HomeMediaActionsController;
    settings: AppSettingsController;
    diagnostics: DiagnosticsController;
    error: ErrorModalController;
    databaseRecovery: DatabaseRecoveryController;
    uiGuards: HomeUiGuardsController;
    // Jumps from a diagnostics "missing media" path to that media in the library.
    onOpenDiagnosticsMedia: (target: DiagnosticsMediaTarget) => void;
};

function formatBackupTimestamp(backedUpAtMs: number | null): string {
    if (backedUpAtMs === null) {
        return "the last automatic backup";
    }

    return `the backup from ${new Date(backedUpAtMs).toLocaleString("en-US")}`;
}

export function HomeModals({
    channels,
    media,
    mediaActions,
    settings,
    diagnostics,
    error,
    databaseRecovery,
    uiGuards,
    onOpenDiagnosticsMedia,
}: HomeModalsProps): JSX.Element {
    const addMediaForm = media.addMediaForm;

    return (
        <>
            <CreateChannelModal
                opened={channels.createChannelOpen}
                onClose={() => channels.setCreateChannelOpen(false)}
                channelName={channels.newChannelName}
                youtubeHandle={channels.newYoutubeHandle}
                avatarMode={channels.newChannelAvatarMode}
                avatarPath={channels.newChannelAvatarPath}
                loading={channels.isCreatingChannel}
                onChangeChannelName={channels.setNewChannelName}
                onChangeYoutubeHandle={channels.setNewYoutubeHandle}
                onChangeAvatarMode={channels.setNewChannelAvatarMode}
                onPickAvatar={() => void channels.pickChannelAvatarViaDialog()}
                onClearAvatar={channels.clearNewChannelAvatarPath}
                onCreate={() => void channels.createChannel()}
            />

            <CreateChannelModal
                opened={channels.editChannelOpen}
                onClose={() => channels.setEditChannelOpen(false)}
                channelName={channels.editChannelName}
                youtubeHandle={channels.editYoutubeHandle}
                avatarMode="none"
                avatarPath=""
                loading={channels.isEditingChannel}
                title={`Edit channel${channels.editingChannel ? ` · ${channels.editingChannel.name}` : ""}`}
                submitLabel="Save"
                allowAvatarEditing={false}
                onChangeChannelName={channels.setEditChannelName}
                onChangeYoutubeHandle={channels.setEditYoutubeHandle}
                onChangeAvatarMode={() => {}}
                onPickAvatar={() => {}}
                onClearAvatar={() => {}}
                onCreate={() => void channels.saveEditedChannel()}
            />

            <AddMediaModal
                opened={media.addMediaOpen}
                onClose={() => void uiGuards.closeAddMediaModalSafely()}
                sourceMode={addMediaForm.sourceMode}
                mediaUrl={addMediaForm.mediaUrl}
                title={addMediaForm.title}
                mediaPath={addMediaForm.mediaPath}
                mediaType={addMediaForm.mediaType}
                thumbPath={addMediaForm.thumbPath}
                publishedAt={addMediaForm.publishedAt}
                downloadComments={addMediaForm.downloadComments}
                downloadLiveChat={addMediaForm.downloadLiveChat}
                cookiesBrowser={addMediaForm.cookiesBrowser}
                cookiesPath={addMediaForm.cookiesPath}
                isGeneratingThumb={addMediaForm.isGeneratingThumb}
                loading={media.isAddingMedia}
                isCancellingYtDlp={media.isCancellingYtDlp}
                ytDlpLogs={media.ytDlpLogs}
                isYtDlpRunning={media.isYtDlpRunning}
                ytDlpFormats={addMediaForm.ytDlpFormats}
                selectedYtDlpFormatId={addMediaForm.selectedYtDlpFormatId}
                isLoadingYtDlpFormats={addMediaForm.isLoadingYtDlpFormats}
                onChangeSourceMode={addMediaForm.setSourceMode}
                onChangeMediaUrl={addMediaForm.setMediaUrl}
                onChangeTitle={addMediaForm.setTitle}
                onChangePublishedAt={addMediaForm.setPublishedAt}
                onChangeDownloadComments={addMediaForm.setDownloadComments}
                onChangeDownloadLiveChat={addMediaForm.setDownloadLiveChat}
                onChangeCookiesBrowser={addMediaForm.setCookiesBrowser}
                onPickCookiesFile={() => void addMediaForm.pickCookiesFileViaDialog()}
                onClearCookiesPath={addMediaForm.clearCookiesPath}
                onChangeSelectedYtDlpFormatId={addMediaForm.setSelectedYtDlpFormatId}
                onLoadYtDlpFormats={() => void addMediaForm.loadYtDlpFormats()}
                onPickMedia={() => void addMediaForm.pickMediaViaDialog()}
                onPickThumb={() => void addMediaForm.pickThumbViaDialog()}
                onAdd={() => void mediaActions.addMedia()}
                onCancelYtDlpDownload={() => void media.cancelYtDlpDownload()}
            />

            <ConfirmDeleteModal
                opened={media.confirmDeleteMediaOpen}
                onClose={media.closeDeleteMediaModal}
                onConfirm={() => void mediaActions.confirmDeleteMedia()}
                loading={media.isDeletingMedia}
                title={<Text fw={900}>Delete</Text>}
                message={
                    <>
                        Delete <b>{media.mediaToDelete?.title ?? "this item"}</b>?
                    </>
                }
                description="This permanently deletes the media file and its thumbnail from disk. This cannot be undone."
            />

            <ConfirmDeleteModal
                opened={channels.confirmDeleteChannelOpen}
                onClose={channels.closeDeleteChannelModal}
                onConfirm={() => void mediaActions.confirmDeleteChannel()}
                loading={channels.isDeletingChannel}
                title={<Text fw={900}>Delete channel</Text>}
                message={
                    <>
                        Delete channel <b>{channels.channelToDelete?.name ?? "this channel"}</b>?
                    </>
                }
                description="This permanently deletes all of this channel's saved videos, audio, thumbnails and live chat replays from disk, and removes its comments. This cannot be undone."
            />

            <SettingsModal
                opened={settings.settingsOpen}
                onClose={settings.closeSettings}
                importMode={settings.settings.importMode}
                libraryPath={settings.settings.libraryPath}
                loadRemoteImages={settings.settings.loadRemoteImages}
                checkUpdatesOnStartup={settings.settings.checkUpdatesOnStartup}
                onChangeImportMode={settings.setImportMode}
                onChangeLoadRemoteImages={settings.setLoadRemoteImages}
                onChangeCheckUpdatesOnStartup={settings.setCheckUpdatesOnStartup}
                onChooseLibraryPath={() => void settings.chooseLibraryPath()}
                onOpenLibraryPath={() => void settings.openCurrentLibraryPath()}
                onOpenDiagnostics={() => {
                    settings.closeSettings();
                    void diagnostics.openDiagnostics();
                }}
                disableLibraryPathChange={uiGuards.disableLibraryPathChange}
                libraryPathChangeDisabledReason={uiGuards.libraryPathChangeDisabledReason}
                isMigratingLibraryPath={settings.isMigratingLibraryPath}
                externalBackupDir={settings.settings.externalBackupDir}
                isSavingExternalBackupDir={settings.isSavingExternalBackupDir}
                onChooseExternalBackupDir={() => void settings.chooseExternalBackupDir()}
                onClearExternalBackupDir={() => void settings.clearExternalBackupDir()}
            />

            <DiagnosticsModal
                opened={diagnostics.diagnosticsOpen}
                onClose={diagnostics.closeDiagnostics}
                onReload={() => void diagnostics.reloadDiagnostics()}
                loading={diagnostics.isLoadingDiagnostics}
                summary={diagnostics.diagnosticsSummary}
                onOpenMedia={onOpenDiagnosticsMedia}
            />

            <ConfirmDeleteModal
                opened={databaseRecovery.open}
                onClose={databaseRecovery.dismiss}
                onConfirm={() => void databaseRecovery.restoreFromBackup()}
                loading={databaseRecovery.isRestoring}
                title={<Text fw={900}>Restore database</Text>}
                message="The database could not be opened and may be corrupted."
                description={`Restore from ${formatBackupTimestamp(
                    databaseRecovery.backedUpAtMs
                )}? The current database is kept aside as a .corrupt file, and the app will reload.`}
                confirmLabel="Restore"
                confirmColor="blue"
                confirmIcon={<RotateCcw size={18} />}
            />

            <ErrorModal
                opened={error.errorOpen}
                onClose={error.closeErrorModal}
                variant={error.errorVariant}
                message={error.errorMessage}
            />
        </>
    );
}
