// The descriptions under "Delete?" and "Delete channel?", by where the files go and, for a channel,
// how much the confirmation knows is about to go.
import { ORPHAN_GRACE_PERIOD_DAYS } from "../../constants/library-retention";
import { formatNumber } from "../../utils/number-format";

// What happens to the files, by the "Delete files right away" setting. By default they go to the
// library's trash, so the confirmation says so rather than calling the deletion permanent. The
// comments are rows in the database, which the trash does not hold, so they are gone either way.
function disposalOf(files: string, skipsTrash: boolean, comments: string): string {
    if (skipsTrash) {
        return `This permanently deletes ${files} from disk, and removes ${comments}. This cannot be undone.`;
    }

    return `This moves ${files} to the library's trash, where they stay for ${ORPHAN_GRACE_PERIOD_DAYS} days, and removes ${comments}, which the trash does not keep.`;
}

export function describeMediaDeletion(skipsTrash: boolean): string {
    return disposalOf(
        "the media file, its thumbnail and live chat replay",
        skipsTrash,
        "its saved comments"
    );
}

// The count is the channel's media total, fetched when the confirmation opens
// (`useChannels.requestDeleteChannel`). `null` is the count not having arrived, or the query having
// failed, and the wording then stays the one that is true of any channel. It is a description of
// scale, not a guard. The delete runs the same whichever line is shown.
export function describeChannelDeletion(mediaCount: number | null, skipsTrash: boolean): string {
    if (mediaCount === 0) {
        return skipsTrash
            ? "This channel has no saved media. Deleting it removes the channel and its images. This cannot be undone."
            : `This channel has no saved media. Deleting it removes the channel and moves its images to the library's trash, where they stay for ${ORPHAN_GRACE_PERIOD_DAYS} days.`;
    }

    if (mediaCount === null) {
        return disposalOf(
            "all of this channel's saved videos, audio, thumbnails and live chat replays",
            skipsTrash,
            "its comments"
        );
    }

    if (mediaCount === 1) {
        return disposalOf(
            "the channel's one saved media file, its thumbnail and live chat replay",
            skipsTrash,
            "its comments"
        );
    }

    return disposalOf(
        `all ${formatNumber(mediaCount)} of the channel's saved videos and audio files, their thumbnails and live chat replays`,
        skipsTrash,
        "their comments"
    );
}
