import { CHANNEL_BANNER_NOT_FOUND_ERROR_CODE } from "../constants/error-codes";
import {
    createChannel,
    ensureChannelCanBeCreated,
    updateChannelImageWithCleanup,
} from "../services/channel-service";
import {
    downloadChannelImageFromHandle,
    persistThumbnailFile,
} from "../services/thumbnail-service";
import { parseAppError } from "../utils/app-error";

export type CreateChannelAvatar =
    | { mode: "none" }
    | { mode: "manual"; sourcePath: string }
    | { mode: "youtube" };

export type CreateChannelResult = {
    channelId: number | null;
    // Why the YouTube avatar could not be downloaded, or null. The channel is created without one
    // then, since the avatar can be set later and a network hiccup should not cost the channel.
    avatarFailure: unknown;
    // Why the banner could not be set, or null. Fetched only with a YouTube avatar, since that is
    // the choice to reach the channel's page, and a channel with no banner is not a failure.
    bannerFailure: unknown;
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
        avatarPath = await persistThumbnailFile(avatar.sourcePath);
    } else if (avatar.mode === "youtube") {
        try {
            avatarPath = await downloadChannelImageFromHandle("avatar", youtubeHandle);
        } catch (error) {
            avatarFailure = error;
        }
    }

    const channelId = await createChannel(name, youtubeHandle, avatarPath);
    let bannerFailure: unknown = null;

    // After the row exists, so a banner that cannot be had costs nothing but the banner.
    if (avatar.mode === "youtube" && channelId !== null) {
        try {
            const bannerPath = await downloadChannelImageFromHandle("banner", youtubeHandle);
            await updateChannelImageWithCleanup("banner", channelId, bannerPath);
        } catch (error) {
            if (parseAppError(error).code !== CHANNEL_BANNER_NOT_FOUND_ERROR_CODE) {
                bannerFailure = error;
            }
        }
    }

    return { channelId, avatarFailure, bannerFailure };
}
