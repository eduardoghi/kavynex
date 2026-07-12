import { useCallback, useMemo, useRef, useState } from "react";
import type { MediaRow } from "../types/media";
import { listChannelMedia } from "../services";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";
import { useRequestGuard } from "./use-request-guard";

type UseChannelMediaListOptions = {
    selectedChannelId: number | null;
    onError: (message: string) => void;
};

type UseChannelMediaListReturn = {
    mediaItems: MediaRow[];
    isLoadingMedia: boolean;
    setMediaItems: React.Dispatch<React.SetStateAction<MediaRow[]>>;
    loadMedia: (channelId?: number | null) => Promise<void>;
    clearMedia: () => void;
};

export function useChannelMediaList({
    selectedChannelId,
    onError,
}: UseChannelMediaListOptions): UseChannelMediaListReturn {
    const [mediaItems, setMediaItems] = useState<MediaRow[]>([]);
    const [isLoadingMedia, setIsLoadingMedia] = useState(false);

    const requestGuard = useRequestGuard();
    const loadedChannelIdRef = useRef<number | null>(null);

    const clearMedia = useCallback((): void => {
        requestGuard.invalidate();
        loadedChannelIdRef.current = null;
        setIsLoadingMedia(false);
        setMediaItems([]);
    }, [requestGuard]);

    const loadMedia = useCallback(
        async (channelId?: number | null): Promise<void> => {
            const targetChannelId =
                typeof channelId === "number" ? channelId : selectedChannelId;

            if (targetChannelId === null || targetChannelId === undefined) {
                clearMedia();
                return;
            }

            const requestId = requestGuard.begin();
            setIsLoadingMedia(true);

            if (loadedChannelIdRef.current !== targetChannelId) {
                setMediaItems([]);
            }

            try {
                const items = await listChannelMedia(targetChannelId);

                if (!requestGuard.isCurrent(requestId)) {
                    return;
                }

                loadedChannelIdRef.current = targetChannelId;
                setMediaItems(items);
            } catch (error) {
                if (!requestGuard.isCurrent(requestId)) {
                    return;
                }

                loadedChannelIdRef.current = null;
                setMediaItems([]);

                logError("media-list", "Failed to load channel media.", error, {
                    channelId: targetChannelId,
                });
                onError(resolveErrorMessage(error, "Failed to load channel media."));
            } finally {
                if (requestGuard.isCurrent(requestId)) {
                    setIsLoadingMedia(false);
                }
            }
        },
        [clearMedia, onError, requestGuard, selectedChannelId]
    );

    // Memoized so the controller object keeps a stable identity across renders where its
    // contents are unchanged, instead of being a fresh literal every render. Consumers that
    // depend on the whole object (or derive callbacks from it) then stop being invalidated on
    // unrelated re-renders. setMediaItems is a stable useState setter, so it is omitted from
    // the dependency list on purpose.
    return useMemo(
        () => ({
            mediaItems,
            isLoadingMedia,
            setMediaItems,
            loadMedia,
            clearMedia,
        }),
        [mediaItems, isLoadingMedia, loadMedia, clearMedia]
    );
}