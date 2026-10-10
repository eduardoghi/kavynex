import { createChannel, ensureChannelCanBeCreated } from "../services/channel-service";
import {
    downloadChannelAvatarFromHandle,
    persistThumbnailFile,
} from "../services/thumbnail-service";

export type CreateChannelAvatar =
    | { mode: "none" }
    | { mode: "manual"; sourcePath: string; libraryPath: string }
    | { mode: "youtube"; libraryPath: string };

export type CreateChannelResult = {
    channelId: number | null;
    // Why the YouTube avatar could not be downloaded, or null. The channel is created without one
    // then, since the avatar can be set later and a network hiccup should not cost the channel.
    avatarFailure: unknown;
};

// Creates a channel and its avatar. Reloading the channel list is left to the caller, because a
// failure there happens after the channel exists and must not be reported as a failed creation.
export async function executeCreateChannel(
    name: string,
    youtubeHandle: string,
    avatar: CreateChannelAvatar
): Promise<CreateChannelResult> {
    // Before the avatar, which is written or downloaded into the library. Refused after that, the
    // file would stay there with no channel pointing at it.
    await ensureChannelCanBeCreated(name, youtubeHandle);

    let avatarPath: string | null = null;
    let avatarFailure: unknown = null;

    if (avatar.mode === "manual") {
        // A file the user picked. Failing to copy it is an error, since creating the channel
        // without it would quietly drop what they asked for.
        avatarPath = await persistThumbnailFile(avatar.sourcePath, avatar.libraryPath);
    } else if (avatar.mode === "youtube") {
        try {
            avatarPath = await downloadChannelAvatarFromHandle(youtubeHandle, avatar.libraryPath);
        } catch (error) {
            avatarFailure = error;
        }
    }

    const channelId = await createChannel(name, youtubeHandle, avatarPath);

    return { channelId, avatarFailure };
}
