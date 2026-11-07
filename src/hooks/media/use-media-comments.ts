import { useEffect, useRef, useState } from "react";
import { useMemoObject } from "../use-memo-object";
import type { MediaCommentRow, MediaRow } from "../../types/media";
import { listMediaComments } from "../../services/media-service";
import { logError } from "../../utils/app-logger";
import { resolveErrorMessage } from "../../utils/error-message";

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
    // The media the comments in state were loaded for, so a refresh can tell "already showing this
    // media's saved comments" from "nothing loaded for it yet".
    const loadedMediaIdRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function loadComments(): Promise<void> {
            if (!media?.id || !media.has_comments) {
                loadedMediaIdRef.current = null;
                setComments([]);
                setError(null);
                setIsLoadingComments(false);
                return;
            }

            // A refresh is in flight and this media's saved comments are already showing. Reloading
            // now would only re-read the pre-refresh rows, so this waits, and the flip back to false
            // re-runs the effect and loads the freshly written ones. That keeps a refresh to one
            // fetch, on its falling edge.
            //
            // When nothing is loaded for it yet (the player opened while the refresh was running),
            // the saved comments are loaded now. Waiting left the panel empty for the whole refresh,
            // reading "none were found in the local database" as if the comments were lost.
            if (isRefreshingComments && loadedMediaIdRef.current === media.id) {
                return;
            }

            setIsLoadingComments(true);
            setError(null);

            try {
                const rows = await listMediaComments(media.id);

                if (!cancelled) {
                    loadedMediaIdRef.current = media.id;
                    setComments(rows);
                }
            } catch (loadFailure) {
                if (!cancelled) {
                    loadedMediaIdRef.current = null;
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

    return useMemoObject({ comments, isLoadingComments, error });
}
