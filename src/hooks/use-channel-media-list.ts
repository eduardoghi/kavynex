import { useCallback, useRef, useState } from "react";
import type { MediaRow } from "../types/media";
import { listChannelMedia } from "../services";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";

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

    const latestRequestIdRef = useRef(0);
    const loadedChannelIdRef = useRef<number | null>(null);

    const clearMedia = useCallback((): void => {
        latestRequestIdRef.current += 1;
        loadedChannelIdRef.current = null;
        setIsLoadingMedia(false);
        setMediaItems([]);
    }, []);

    const loadMedia = useCallback(
        async (channelId?: number | null): Promise<void> => {
            const targetChannelId =
                typeof channelId === "number" ? channelId : selectedChannelId;

            if (targetChannelId === null || targetChannelId === undefined) {
                clearMedia();
                return;
            }

            const requestId = ++latestRequestIdRef.current;
            setIsLoadingMedia(true);

            if (loadedChannelIdRef.current !== targetChannelId) {
                setMediaItems([]);
            }

            try {
                const items = await listChannelMedia(targetChannelId);

                if (requestId !== latestRequestIdRef.current) {
                    return;
                }

                loadedChannelIdRef.current = targetChannelId;
                setMediaItems(items);
            } catch (error) {
                if (requestId !== latestRequestIdRef.current) {
                    return;
                }

                loadedChannelIdRef.current = null;
                setMediaItems([]);

                logError("media-list", "Failed to load channel media.", error, {
                    channelId: targetChannelId,
                });
                onError(resolveErrorMessage(error, "Failed to load channel media."));
            } finally {
                if (requestId === latestRequestIdRef.current) {
                    setIsLoadingMedia(false);
                }
            }
        },
        [clearMedia, onError, selectedChannelId]
    );

    return {
        mediaItems,
        isLoadingMedia,
        setMediaItems,
        loadMedia,
        clearMedia,
    };
}