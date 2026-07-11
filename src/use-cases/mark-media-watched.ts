import type { MediaRow } from "../types/media";
import { setMediaWatched } from "../services";

type ExecuteMarkMediaWatchedOptions = {
    mediaId: number;
    updateMediaItems: React.Dispatch<React.SetStateAction<MediaRow[]>>;
};

export async function executeMarkMediaWatched({
    mediaId,
    updateMediaItems,
}: ExecuteMarkMediaWatchedOptions): Promise<string> {
    // Use the timestamp the database actually persisted (returned by the command) instead of a
    // client clock value, so the list and the active media match exactly what a reload shows.
    const watchedAt = await setMediaWatched(mediaId);

    updateMediaItems((currentItems) =>
        currentItems.map((item) =>
            item.id === mediaId
                ? {
                      ...item,
                      watched_at: watchedAt,
                      progress_seconds: 0,
                  }
                : item
        )
    );

    return watchedAt;
}