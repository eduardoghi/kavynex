type ExecuteDeleteSelectedChannelInput = {
    selectedChannelId: number | null;
    channelToDeleteId: number | null;
    closeSelectedChannelUiBeforeDelete: () => Promise<void>;
    deleteChannelMediaFilesBeforeDelete?: () => Promise<void>;
    confirmDeleteChannel: () => Promise<void>;
};

export async function executeDeleteSelectedChannel({
    selectedChannelId,
    channelToDeleteId,
    closeSelectedChannelUiBeforeDelete,
    deleteChannelMediaFilesBeforeDelete,
    confirmDeleteChannel,
}: ExecuteDeleteSelectedChannelInput): Promise<void> {
    const isDeletingSelectedChannel =
        selectedChannelId !== null &&
        channelToDeleteId !== null &&
        selectedChannelId === channelToDeleteId;

    if (isDeletingSelectedChannel) {
        await closeSelectedChannelUiBeforeDelete();
    }

    if (deleteChannelMediaFilesBeforeDelete) {
        await deleteChannelMediaFilesBeforeDelete();
    }

    await confirmDeleteChannel();
}