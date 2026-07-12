import { useEffect, useState } from "react";
import type { MediaRow } from "../types/media";
import {
    readLiveChatMessagesFromFile,
    type LiveChatMessageItem,
} from "../services/live-chat-service";
import { logError } from "../utils/app-logger";

type UseMediaLiveChatResult = {
    liveChatMessages: LiveChatMessageItem[];
    isLoadingLiveChat: boolean;
};

// Loads the gzip-compressed live chat replay for the active media from disk, reloading when the
// media (or its live-chat file path) changes. Extracted from MediaPlayerView so the file read
// and its load/empty/error handling live apart from rendering.
export function useMediaLiveChat(
    media: MediaRow | null,
    libraryPath: string
): UseMediaLiveChatResult {
    const [liveChatMessages, setLiveChatMessages] = useState<LiveChatMessageItem[]>([]);
    const [isLoadingLiveChat, setIsLoadingLiveChat] = useState(false);

    useEffect(() => {
        let cancelled = false;

        async function loadLiveChat(): Promise<void> {
            if (!media?.id || !media.live_chat_file_path?.trim() || !media.has_live_chat) {
                setLiveChatMessages([]);
                setIsLoadingLiveChat(false);
                return;
            }

            setIsLoadingLiveChat(true);

            try {
                const rows = await readLiveChatMessagesFromFile(media.live_chat_file_path);

                if (!cancelled) {
                    setLiveChatMessages(rows);
                }
            } catch (error) {
                if (!cancelled) {
                    setLiveChatMessages([]);
                }

                logError("media-player", "Failed to load live chat replay from file.", error, {
                    mediaId: media.id,
                    liveChatFilePath: media.live_chat_file_path,
                    libraryPath,
                });
            } finally {
                if (!cancelled) {
                    setIsLoadingLiveChat(false);
                }
            }
        }

        void loadLiveChat();

        return () => {
            cancelled = true;
        };
    }, [libraryPath, media?.has_live_chat, media?.id, media?.live_chat_file_path]);

    return { liveChatMessages, isLoadingLiveChat };
}
