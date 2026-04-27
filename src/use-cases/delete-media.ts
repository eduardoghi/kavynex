import type { MediaRow } from "../types/media";
import { deleteMediaWithFileCleanup } from "../services";

type ExecuteDeleteMediaOptions = {
    media: MediaRow;
    libraryPath: string;
    reloadMedia: () => Promise<void>;
    closePlayerIfActive: (mediaId: number) => void;
};

export async function executeDeleteMedia({
    media,
    libraryPath,
    reloadMedia,
    closePlayerIfActive,
}: ExecuteDeleteMediaOptions): Promise<void> {
    await deleteMediaWithFileCleanup(
        media.id,
        media.file_path,
        media.thumbnail_path,
        libraryPath,
        media.live_chat_file_path ?? null
    );

    closePlayerIfActive(media.id);
    await reloadMedia();
}