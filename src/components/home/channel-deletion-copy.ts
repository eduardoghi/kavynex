// The description under "Delete channel?", by how much the confirmation knows is about to go.
//
// The count is the channel's media total, fetched when the confirmation opens
// (`useChannels.requestDeleteChannel`). `null` is the count not having arrived, or the query having
// failed, and the wording then stays the one that is true of any channel. It is a description of
// scale, not a guard. The delete runs the same whichever line is shown.
export function describeChannelDeletion(mediaCount: number | null): string {
    if (mediaCount === null) {
        return "This permanently deletes all of this channel's saved videos, audio, thumbnails and live chat replays from disk, and removes its comments. This cannot be undone.";
    }

    if (mediaCount === 0) {
        return "This channel has no saved media. Deleting it removes the channel and its avatar. This cannot be undone.";
    }

    if (mediaCount === 1) {
        return "This permanently deletes the channel's one saved media file, its thumbnail and live chat replay from disk, and removes its comments. This cannot be undone.";
    }

    return `This permanently deletes all ${mediaCount.toLocaleString("en-US")} of the channel's saved videos and audio files, their thumbnails and live chat replays from disk, and removes their comments. This cannot be undone.`;
}
