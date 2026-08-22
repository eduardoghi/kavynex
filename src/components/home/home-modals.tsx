import { lazy, memo, Suspense } from "react";
import { Text } from "@mantine/core";
import { RotateCcw } from "lucide-react";
import { AddMediaModal } from "../modals/add-media-modal";
import { ConfirmDeleteModal } from "../modals/confirm-delete-modal";
import { CreateChannelModal } from "../modals/create-channel-modal";
import { ErrorModal } from "../modals/error-modal";
import { useHasBeenTrue } from "../../hooks/use-has-been-true";

// The two heaviest modals, and the two the app can run a whole session without opening. Settings
// pulls in its five sections (the database export/import/restore flow among them) and Diagnostics
// pulls in the whole library-integrity report and its rules. None of which is on the path to the
// first paint, which is the grid.
//
// Lazy alone would not defer anything here: both are mounted unconditionally and told whether they
// are `opened`, so their chunks would be requested on the first render like any static import.
// `useHasBeenTrue` below is what actually holds the mount back until the first open, and what keeps
// them mounted afterwards so closing still runs the modal's own exit transition. The other modals
// stay static: each is small, and the delete confirmation in particular gates a destructive action
// that should not wait on a chunk.
const DiagnosticsModal = lazy(() =>
    import("../modals/diagnostics-modal").then((module) => ({ default: module.DiagnosticsModal }))
);
const SettingsModal = lazy(() =>
    import("../modals/settings-modal").then((module) => ({ default: module.SettingsModal }))
);
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

// Every modal except AddMediaModal. Split out and memoized so an active yt-dlp download (whose log
// lines change `media`'s identity several times a second), re-renders only AddMediaModal (which
// shows the terminal), not this whole set. It deliberately receives the individual delete-media
// fields rather than the `media` controller, so its props stay referentially stable across a log
// update; every other slice it takes is already memoized by its own hook.
type HomeSecondaryModalsProps = {
    channels: ChannelsController;
    mediaActions: HomeMediaActionsController;
    settings: AppSettingsController;
    diagnostics: DiagnosticsController;
    error: ErrorModalController;
    databaseRecovery: DatabaseRecoveryController;
    uiGuards: HomeUiGuardsController;
    onOpenDiagnosticsMedia: (target: DiagnosticsMediaTarget) => void;
    confirmDeleteMediaOpen: boolean;
    mediaToDelete: MediaLibraryController["mediaToDelete"];
    isDeletingMedia: boolean;
    closeDeleteMediaModal: MediaLibraryController["closeDeleteMediaModal"];
};

const HomeSecondaryModals = memo(function HomeSecondaryModals({
    channels,
    mediaActions,
    settings,
    diagnostics,
    error,
    databaseRecovery,
    uiGuards,
    onOpenDiagnosticsMedia,
    confirmDeleteMediaOpen,
    mediaToDelete,
    isDeletingMedia,
    closeDeleteMediaModal,
}: HomeSecondaryModalsProps): JSX.Element {
    // Latched rather than read directly, so each lazy modal below mounts on its first open and
    // stays mounted after. See useHasBeenTrue for why both halves are load-bearing.
    const settingsWasOpened = useHasBeenTrue(settings.settingsOpen);
    const diagnosticsWasOpened = useHasBeenTrue(diagnostics.diagnosticsOpen);

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

            {/* Just the screen's name. The channel it edits is the value in the Name field
                inside, so the title was repeating it. */}
            <CreateChannelModal
                opened={channels.editChannelOpen}
                onClose={() => channels.setEditChannelOpen(false)}
                channelName={channels.editChannelName}
                youtubeHandle={channels.editYoutubeHandle}
                avatarMode="none"
                avatarPath=""
                loading={channels.isEditingChannel}
                title="Edit channel"
                submitLabel="Save"
                submitLoadingLabel="Saving..."
                allowAvatarEditing={false}
                onChangeChannelName={channels.setEditChannelName}
                onChangeYoutubeHandle={channels.setEditYoutubeHandle}
                onCreate={() => void channels.saveEditedChannel()}
            />

            <ConfirmDeleteModal
                opened={confirmDeleteMediaOpen}
                onClose={closeDeleteMediaModal}
                onConfirm={() => void mediaActions.confirmDeleteMedia()}
                loading={isDeletingMedia}
                title={<Text fw={900}>Delete</Text>}
                message={
                    <>
                        Delete <b>{mediaToDelete?.title ?? "this item"}</b>?
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

            {settingsWasOpened ? (
                // `null` while the chunk arrives: this renders only once, on the first open, and
                // the modal's own overlay is what the user is waiting for. A spinner in its place
                // would flash for a frame and then be replaced by the real overlay.
                <Suspense fallback={null}>
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
                        libraryPathChangeDisabledReason={
                            uiGuards.libraryPathChangeDisabledReason
                        }
                        isMigratingLibraryPath={settings.isMigratingLibraryPath}
                        externalBackupDir={settings.settings.externalBackupDir}
                        isSavingExternalBackupDir={settings.isSavingExternalBackupDir}
                        onChooseExternalBackupDir={() =>
                            void settings.chooseExternalBackupDir()
                        }
                        onClearExternalBackupDir={() => void settings.clearExternalBackupDir()}
                    />
                </Suspense>
            ) : null}

            {diagnosticsWasOpened ? (
                <Suspense fallback={null}>
                    <DiagnosticsModal
                        opened={diagnostics.diagnosticsOpen}
                        onClose={diagnostics.closeDiagnostics}
                        onReload={() => void diagnostics.reloadDiagnostics()}
                        loading={diagnostics.isLoadingDiagnostics}
                        summary={diagnostics.diagnosticsSummary}
                        onOpenMedia={onOpenDiagnosticsMedia}
                        onRevealPath={(path) => void diagnostics.revealLibraryPath(path)}
                        onOpenLogFolder={() => void diagnostics.openLogDirectory()}
                        openingLogFolder={diagnostics.isOpeningLogDirectory}
                    />
                </Suspense>
            ) : null}

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
});

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
                cookiesBrowserProfile={addMediaForm.cookiesBrowserProfile}
                cookiesPath={addMediaForm.cookiesPath}
                isGeneratingThumb={addMediaForm.isGeneratingThumb}
                loading={media.isAddingMedia}
                isCancellingYtDlp={media.isCancellingYtDlp}
                ytDlpLogs={media.ytDlpLogs}
                isYtDlpRunning={media.isYtDlpRunning}
                ytDlpProgress={media.ytDlpProgress}
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
                onChangeCookiesBrowserProfile={addMediaForm.setCookiesBrowserProfile}
                onPickCookiesFile={() => void addMediaForm.pickCookiesFileViaDialog()}
                onClearCookiesPath={addMediaForm.clearCookiesPath}
                onChangeSelectedYtDlpFormatId={addMediaForm.setSelectedYtDlpFormatId}
                onLoadYtDlpFormats={() => void addMediaForm.loadYtDlpFormats()}
                onPickMedia={() => void addMediaForm.pickMediaViaDialog()}
                onPickThumb={() => void addMediaForm.pickThumbViaDialog()}
                onAdd={() => void mediaActions.addMedia()}
                onCancelYtDlpDownload={() => void media.cancelYtDlpDownload()}
            />

            <HomeSecondaryModals
                channels={channels}
                mediaActions={mediaActions}
                settings={settings}
                diagnostics={diagnostics}
                error={error}
                databaseRecovery={databaseRecovery}
                uiGuards={uiGuards}
                onOpenDiagnosticsMedia={onOpenDiagnosticsMedia}
                confirmDeleteMediaOpen={media.confirmDeleteMediaOpen}
                mediaToDelete={media.mediaToDelete}
                isDeletingMedia={media.isDeletingMedia}
                closeDeleteMediaModal={media.closeDeleteMediaModal}
            />
        </>
    );
}
