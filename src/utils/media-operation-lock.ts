export type MediaPreparationState = {
    isAddingMedia: boolean;
    isYtDlpRunning: boolean;
    isCancellingYtDlp: boolean;
    isGeneratingThumb: boolean;
    isLoadingYtDlpFormats: boolean;
};

export function isMediaOperationLocked(state: MediaPreparationState): boolean {
    return (
        state.isAddingMedia ||
        state.isYtDlpRunning ||
        state.isCancellingYtDlp ||
        state.isGeneratingThumb ||
        state.isLoadingYtDlpFormats
    );
}

export function resolveMediaOperationLockReason(state: MediaPreparationState): string {
    if (state.isAddingMedia || state.isYtDlpRunning || state.isCancellingYtDlp) {
        return "You cannot change the library folder while media is being imported or downloaded.";
    }

    if (state.isGeneratingThumb || state.isLoadingYtDlpFormats) {
        return "You cannot change the library folder while media preparation is in progress.";
    }

    return "";
}