import type { MediaRow } from "../types/media";
import { setMediaUnwatched, setMediaWatched } from "../services/media-service";
import { updateItemById } from "../utils/update-item-by-id";

/**
 * What marking a media watched or unwatched changes in its row. Watched also resets the playback
 * progress, as the backend does, so the list, the open player and a reload all agree.
 */
export type WatchedChange = Pick<MediaRow, "watched_at"> &
    Partial<Pick<MediaRow, "progress_seconds">>;

type ExecuteSetMediaWatchedOptions = {
    mediaId: number;
    watched: boolean;
    updateMediaItems: React.Dispatch<React.SetStateAction<MediaRow[]>>;
};

/** Marks a media watched or unwatched, applies the change to the list, and returns it. */
export async function executeSetMediaWatched({
    mediaId,
    watched,
    updateMediaItems,
}: ExecuteSetMediaWatchedOptions): Promise<WatchedChange> {
    let change: WatchedChange;

    if (watched) {
        // The timestamp the database persisted (returned by the command), not a client clock, so
        // the list and the active media match exactly what a reload shows.
        change = { watched_at: await setMediaWatched(mediaId), progress_seconds: 0 };
    } else {
        await setMediaUnwatched(mediaId);
        change = { watched_at: null };
    }

    updateMediaItems((currentItems) =>
        currentItems.map((item) =>
            updateItemById(item, mediaId, (current) => ({ ...current, ...change }))
        )
    );

    return change;
}
