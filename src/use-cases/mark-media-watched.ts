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
    await setMediaWatched(mediaId);

    const watchedAt = new Date().toISOString();

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