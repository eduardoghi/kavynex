import { createChannel } from "../services";

export type ExecuteCreateChannelInput = {
    name: string;
    youtubeHandle: string;
    avatarPath?: string | null;
};

type ExecuteCreateChannelOptions = {
    input: ExecuteCreateChannelInput;
    reloadChannels: () => Promise<void>;
    selectChannel: (channelId: number | null) => void;
    resetForm: () => void;
};

export async function executeCreateChannel({
    input,
    reloadChannels,
    selectChannel,
    resetForm,
}: ExecuteCreateChannelOptions): Promise<void> {
    const createdChannelId = await createChannel(
        input.name,
        input.youtubeHandle,
        input.avatarPath ?? null
    );

    await reloadChannels();
    selectChannel(createdChannelId);
    resetForm();
}