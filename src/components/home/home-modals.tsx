import { Text } from "@mantine/core";
import { AddMediaModal } from "../modals/add-media-modal";
import { ConfirmDeleteModal } from "../modals/confirm-delete-modal";
import { CreateChannelModal } from "../modals/create-channel-modal";
import { DiagnosticsModal } from "../modals/diagnostics-modal";
import { ErrorModal } from "../modals/error-modal";
import { SettingsModal } from "../modals/settings-modal";
import type { HomeController } from "../../types/controllers";

type HomeModalsController = Pick<
    HomeController,
    | "createChannelOpen"
    | "setCreateChannelOpen"
    | "newChannelName"
    | "setNewChannelName"
    | "newYoutubeHandle"
    | "setNewYoutubeHandle"
    | "newChannelAvatarMode"
    | "setNewChannelAvatarMode"
    | "newChannelAvatarPath"
    | "pickChannelAvatarViaDialog"
    | "clearNewChannelAvatarPath"
    | "isCreatingChannel"
    | "createChannel"
    | "editChannelOpen"
    | "setEditChannelOpen"
    | "editingChannel"
    | "editChannelName"
    | "setEditChannelName"
    | "editYoutubeHandle"
    | "setEditYoutubeHandle"
    | "isEditingChannel"
    | "saveEditedChannel"
    | "addMediaOpen"
    | "closeAddMediaModal"
    | "addMediaForm"
    | "isAddingMedia"
    | "isCancellingYtDlp"
    | "ytDlpLogs"
    | "isYtDlpRunning"
    | "addMedia"
    | "cancelYtDlpDownload"
    | "confirmDeleteMediaOpen"
    | "closeDeleteMediaModal"
    | "confirmDeleteMedia"
    | "isDeletingMedia"
    | "mediaToDelete"
    | "confirmDeleteChannelOpen"
    | "closeDeleteChannelModal"
    | "confirmDeleteChannel"
    | "isDeletingChannel"
    | "channelToDelete"
    | "settingsOpen"
    | "closeSettings"
    | "importMode"
    | "libraryPath"
    | "setImportMode"
    | "chooseLibraryPath"
    | "openCurrentLibraryPath"
    | "openDiagnostics"
    | "disableLibraryPathChange"
    | "libraryPathChangeDisabledReason"
    | "isMigratingLibraryPath"
    | "diagnosticsOpen"
    | "closeDiagnostics"
    | "reloadDiagnostics"
    | "isLoadingDiagnostics"
    | "diagnosticsSummary"
    | "errorOpen"
    | "closeErrorModal"
    | "errorMessage"
>;

type HomeModalsProps = {
    controller: HomeModalsController;
};

export function HomeModals({
    controller,
}: HomeModalsProps): JSX.Element {
    return (
        <>
            <CreateChannelModal
                opened={controller.createChannelOpen}
                onClose={() => controller.setCreateChannelOpen(false)}
                channelName={controller.newChannelName}
                youtubeHandle={controller.newYoutubeHandle}
                avatarMode={controller.newChannelAvatarMode}
                avatarPath={controller.newChannelAvatarPath}
                loading={controller.isCreatingChannel}
                onChangeChannelName={controller.setNewChannelName}
                onChangeYoutubeHandle={controller.setNewYoutubeHandle}
                onChangeAvatarMode={controller.setNewChannelAvatarMode}
                onPickAvatar={() => void controller.pickChannelAvatarViaDialog()}
                onClearAvatar={controller.clearNewChannelAvatarPath}
                onCreate={() => void controller.createChannel()}
            />

            <CreateChannelModal
                opened={controller.editChannelOpen}
                onClose={() => controller.setEditChannelOpen(false)}
                channelName={controller.editChannelName}
                youtubeHandle={controller.editYoutubeHandle}
                avatarMode="none"
                avatarPath=""
                loading={controller.isEditingChannel}
                title={`Edit channel${controller.editingChannel ? ` · ${controller.editingChannel.name}` : ""}`}
                submitLabel="Save"
                allowAvatarEditing={false}
                onChangeChannelName={controller.setEditChannelName}
                onChangeYoutubeHandle={controller.setEditYoutubeHandle}
                onChangeAvatarMode={() => {}}
                onPickAvatar={() => {}}
                onClearAvatar={() => {}}
                onCreate={() => void controller.saveEditedChannel()}
            />

            <AddMediaModal
                opened={controller.addMediaOpen}
                onClose={() => void controller.closeAddMediaModal()}
                sourceMode={controller.addMediaForm.sourceMode}
                mediaUrl={controller.addMediaForm.mediaUrl}
                title={controller.addMediaForm.title}
                mediaPath={controller.addMediaForm.mediaPath}
                mediaType={controller.addMediaForm.mediaType}
                thumbPath={controller.addMediaForm.thumbPath}
                publishedAt={controller.addMediaForm.publishedAt}
                downloadComments={controller.addMediaForm.downloadComments}
                downloadLiveChat={controller.addMediaForm.downloadLiveChat}
                cookiesBrowser={controller.addMediaForm.cookiesBrowser}
                cookiesPath={controller.addMediaForm.cookiesPath}
                isGeneratingThumb={controller.addMediaForm.isGeneratingThumb}
                loading={controller.isAddingMedia}
                isCancellingYtDlp={controller.isCancellingYtDlp}
                ytDlpLogs={controller.ytDlpLogs}
                isYtDlpRunning={controller.isYtDlpRunning}
                ytDlpFormats={controller.addMediaForm.ytDlpFormats}
                selectedYtDlpFormatId={controller.addMediaForm.selectedYtDlpFormatId}
                isLoadingYtDlpFormats={controller.addMediaForm.isLoadingYtDlpFormats}
                onChangeSourceMode={controller.addMediaForm.setSourceMode}
                onChangeMediaUrl={controller.addMediaForm.setMediaUrl}
                onChangeTitle={controller.addMediaForm.setTitle}
                onChangePublishedAt={controller.addMediaForm.setPublishedAt}
                onChangeDownloadComments={controller.addMediaForm.setDownloadComments}
                onChangeDownloadLiveChat={controller.addMediaForm.setDownloadLiveChat}
                onChangeCookiesBrowser={controller.addMediaForm.setCookiesBrowser}
                onChangeCookiesPath={controller.addMediaForm.setCookiesPath}
                onPickCookiesFile={() => void controller.addMediaForm.pickCookiesFileViaDialog()}
                onClearCookiesPath={controller.addMediaForm.clearCookiesPath}
                onChangeSelectedYtDlpFormatId={controller.addMediaForm.setSelectedYtDlpFormatId}
                onLoadYtDlpFormats={() => void controller.addMediaForm.loadYtDlpFormats()}
                onPickMedia={() => void controller.addMediaForm.pickMediaViaDialog()}
                onPickThumb={() => void controller.addMediaForm.pickThumbViaDialog()}
                onAdd={() => void controller.addMedia()}
                onCancelYtDlpDownload={() => void controller.cancelYtDlpDownload()}
            />

            <ConfirmDeleteModal
                opened={controller.confirmDeleteMediaOpen}
                onClose={controller.closeDeleteMediaModal}
                onConfirm={() => void controller.confirmDeleteMedia()}
                loading={controller.isDeletingMedia}
                title={<Text fw={900}>Delete</Text>}
                message={
                    <>
                        Delete <b>{controller.mediaToDelete?.title ?? "this item"}</b>?
                    </>
                }
                description="This will remove it from the library."
            />

            <ConfirmDeleteModal
                opened={controller.confirmDeleteChannelOpen}
                onClose={controller.closeDeleteChannelModal}
                onConfirm={() => void controller.confirmDeleteChannel()}
                loading={controller.isDeletingChannel}
                title={<Text fw={900}>Delete channel</Text>}
                message={
                    <>
                        Delete channel <b>{controller.channelToDelete?.name ?? "this channel"}</b>?
                    </>
                }
                description="Channel records will be removed."
            />

            <SettingsModal
                opened={controller.settingsOpen}
                onClose={controller.closeSettings}
                importMode={controller.importMode}
                libraryPath={controller.libraryPath}
                onChangeImportMode={controller.setImportMode}
                onChooseLibraryPath={() => void controller.chooseLibraryPath()}
                onOpenLibraryPath={() => void controller.openCurrentLibraryPath()}
                onOpenDiagnostics={() => {
                    controller.closeSettings();
                    void controller.openDiagnostics();
                }}
                disableLibraryPathChange={controller.disableLibraryPathChange}
                libraryPathChangeDisabledReason={controller.libraryPathChangeDisabledReason}
                isMigratingLibraryPath={controller.isMigratingLibraryPath}
            />

            <DiagnosticsModal
                opened={controller.diagnosticsOpen}
                onClose={controller.closeDiagnostics}
                onReload={() => void controller.reloadDiagnostics()}
                loading={controller.isLoadingDiagnostics}
                summary={controller.diagnosticsSummary}
            />

            <ErrorModal
                opened={controller.errorOpen}
                onClose={controller.closeErrorModal}
                message={controller.errorMessage}
            />
        </>
    );
}