export type MediaPreparationState = {
    isAddingMedia: boolean;
    isYtDlpRunning: boolean;
    isCancellingYtDlp: boolean;
    isGeneratingThumb: boolean;
    isLoadingYtDlpFormats: boolean;
};

// Read-only busy predicate for UI guards. This is not a mutual-exclusion primitive: the
// actual reentrancy protection lives in each operation's useAsyncFlag.
export function isMediaOperationBusy(state: MediaPreparationState): boolean {
    return (
        state.isAddingMedia ||
        state.isYtDlpRunning ||
        state.isCancellingYtDlp ||
        state.isGeneratingThumb ||
        state.isLoadingYtDlpFormats
    );
}

export function resolveMediaOperationBusyReason(state: MediaPreparationState): string {
    if (state.isAddingMedia || state.isYtDlpRunning || state.isCancellingYtDlp) {
        return "You cannot change the library folder while media is being imported or downloaded.";
    }

    if (state.isGeneratingThumb || state.isLoadingYtDlpFormats) {
        return "You cannot change the library folder while media preparation is in progress.";
    }

    return "";
}