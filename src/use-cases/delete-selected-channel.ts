type ExecuteDeleteSelectedChannelInput = {
    selectedChannelId: number | null;
    channelToDeleteId: number | null;
    closeSelectedChannelUiBeforeDelete: () => Promise<void>;
    confirmDeleteChannel: () => Promise<void>;
};

export async function executeDeleteSelectedChannel({
    selectedChannelId,
    channelToDeleteId,
    closeSelectedChannelUiBeforeDelete,
    confirmDeleteChannel,
}: ExecuteDeleteSelectedChannelInput): Promise<void> {
    const isDeletingSelectedChannel =
        selectedChannelId !== null &&
        channelToDeleteId !== null &&
        selectedChannelId === channelToDeleteId;

    if (isDeletingSelectedChannel) {
        await closeSelectedChannelUiBeforeDelete();
    }

    await confirmDeleteChannel();
}
