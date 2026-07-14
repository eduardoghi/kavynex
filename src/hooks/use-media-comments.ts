import { useEffect, useState } from "react";
import type { MediaCommentRow, MediaRow } from "../types/media";
import { listMediaComments } from "../services/media-service";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";

type UseMediaCommentsResult = {
    comments: MediaCommentRow[];
    isLoadingComments: boolean;
    // Non-null only when the load actually failed, so the panel can tell a read failure apart from
    // "this media genuinely has no comments" instead of silently showing an empty/"missing from
    // database" state for what was really a transient disk or decode error.
    error: string | null;
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
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function loadComments(): Promise<void> {
            if (!media?.id || !media.has_comments) {
                setComments([]);
                setError(null);
                setIsLoadingComments(false);
                return;
            }

            setIsLoadingComments(true);
            setError(null);

            try {
                const rows = await listMediaComments(media.id);

                if (!cancelled) {
                    setComments(rows);
                }
            } catch (loadFailure) {
                if (!cancelled) {
                    setComments([]);
                    setError(
                        resolveErrorMessage(
                            loadFailure,
                            "Could not load the saved comments for this media."
                        )
                    );
                }

                logError("media-player", "Failed to load saved comments.", loadFailure, {
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

    return { comments, isLoadingComments, error };
}
