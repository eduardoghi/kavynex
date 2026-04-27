import type { MediaRow } from "../types/media";
import { setMediaUnwatched } from "../services";

type ExecuteMarkMediaUnwatchedOptions = {
    mediaId: number;
    updateMediaItems: React.Dispatch<React.SetStateAction<MediaRow[]>>;
};

export async function executeMarkMediaUnwatched({
    mediaId,
    updateMediaItems,
}: ExecuteMarkMediaUnwatchedOptions): Promise<void> {
    await setMediaUnwatched(mediaId);

    updateMediaItems((currentItems) =>
        currentItems.map((item) =>
            item.id === mediaId
                ? {
                      ...item,
                      watched_at: null,
                  }
                : item
        )
    );
}