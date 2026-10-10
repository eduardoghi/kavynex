import type {
    AddingMediaSlice,
    DeletingMediaSlice,
    MediaItemActionsSlice,
    MediaLibraryController,
    MediaListSlice,
} from "../../hooks/media/use-media-library";

export type FlatMediaLibraryController = MediaListSlice &
    AddingMediaSlice &
    DeletingMediaSlice &
    MediaItemActionsSlice &
    Pick<MediaLibraryController, "mediaPlayer" | "clearMediaAndPlayer">;

// Builds the sliced controller from one flat object, so a fixture can list (and a test can
// override) every field in one place without knowing which slice it belongs to.
export function nestMediaLibrary(flat: FlatMediaLibraryController): MediaLibraryController {
    return {
        list: {
            mediaItems: flat.mediaItems,
            mediaTotal: flat.mediaTotal,
            channelMediaTotal: flat.channelMediaTotal,
            hasMoreMedia: flat.hasMoreMedia,
            loadMoreMediaFailed: flat.loadMoreMediaFailed,
            mediaLoadError: flat.mediaLoadError,
            isLoadingMedia: flat.isLoadingMedia,
            isLoadingMoreMedia: flat.isLoadingMoreMedia,
            applyMediaQuery: flat.applyMediaQuery,
            loadMoreMedia: flat.loadMoreMedia,
            reloadMedia: flat.reloadMedia,
        },
        adding: {
            addMediaOpen: flat.addMediaOpen,
            setAddMediaOpen: flat.setAddMediaOpen,
            closeAddMediaModal: flat.closeAddMediaModal,
            isAddingMedia: flat.isAddingMedia,
            isCancellingYtDlp: flat.isCancellingYtDlp,
            isFetchingComments: flat.isFetchingComments,
            ytDlpTerminalStore: flat.ytDlpTerminalStore,
            isYtDlpRunning: flat.isYtDlpRunning,
            addMediaForm: flat.addMediaForm,
            addMedia: flat.addMedia,
            cancelYtDlpDownload: flat.cancelYtDlpDownload,
        },
        deletion: {
            confirmDeleteMediaOpen: flat.confirmDeleteMediaOpen,
            mediaToDelete: flat.mediaToDelete,
            isDeletingMedia: flat.isDeletingMedia,
            requestDeleteMedia: flat.requestDeleteMedia,
            confirmDeleteMedia: flat.confirmDeleteMedia,
            closeDeleteMediaModal: flat.closeDeleteMediaModal,
        },
        itemActions: {
            commentsInFlight: flat.commentsInFlight,
            watchedActionInFlight: flat.watchedActionInFlight,
            isUpdatingTitle: flat.isUpdatingTitle,
            markAsWatched: flat.markAsWatched,
            markAsUnwatched: flat.markAsUnwatched,
            refreshComments: flat.refreshComments,
            cancelRefreshComments: flat.cancelRefreshComments,
            editTitle: flat.editTitle,
            openMediaFileLocation: flat.openMediaFileLocation,
            openMediaSourceInYoutube: flat.openMediaSourceInYoutube,
            saveMediaProgress: flat.saveMediaProgress,
        },
        mediaPlayer: flat.mediaPlayer,
        clearMediaAndPlayer: flat.clearMediaAndPlayer,
    };
}
