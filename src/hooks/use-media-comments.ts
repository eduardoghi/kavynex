import { useEffect, useState } from "react";
import type { MediaCommentRow, MediaRow } from "../types/media";
import { listMediaComments } from "../services/media-service";
import { logError } from "../utils/app-logger";

type UseMediaCommentsResult = {
    comments: MediaCommentRow[];
    isLoadingComments: boolean;
};

// Loads the saved comments for the active media, reloading when the media changes or after a
// comment refresh completes (`isRefreshingComments` flipping back to false). Extracted from
// MediaPlayerView so the load/empty/error handling is isolated from rendering.
export function useMediaComments(
    media: MediaRow | null,
    isRefreshingComments: boolean
): UseMediaCommentsResult {
    const [comments, setComments] = useState<MediaCommentRow[]>([]);
    const [isLoadingComments, setIsLoadingComments] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function loadComments(): Promise<void> {
            if (!media?.id || !media.has_comments) {
                setComments([]);
                setIsLoadingComments(false);
                return;
            }

            setIsLoadingComments(true);

            try {
                const rows = await listMediaComments(media.id);

                if (!cancelled) {
                    setComments(rows);
                }
            } catch (error) {
                if (!cancelled) {
                    setComments([]);
                }

                logError("media-player", "Failed to load saved comments.", error, {
                    mediaId: media.id,
                });
            } finally {
                if (!cancelled) {
                    setIsLoadingComments(false);
                }
            }
        }

        void loadComments();

        return () => {
            cancelled = true;
        };
    }, [media?.has_comments, media?.id, isRefreshingComments]);

    return { comments, isLoadingComments };
}
