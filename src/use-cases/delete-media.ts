import type { MediaRow } from "../types/media";
import { deleteMediaWithFileCleanup } from "../services/media-service";

type ExecuteDeleteMediaOptions = {
    media: MediaRow;
    reloadMedia: () => Promise<void>;
    closePlayerIfActive: (mediaId: number) => void;
};

export async function executeDeleteMedia({
    media,
    reloadMedia,
    closePlayerIfActive,
}: ExecuteDeleteMediaOptions): Promise<void> {
    await deleteMediaWithFileCleanup(media.id);

    closePlayerIfActive(media.id);
    await reloadMedia();
}
