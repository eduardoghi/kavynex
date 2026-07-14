import { useEffect, useState } from "react";
import type { MediaRow } from "../types/media";
import {
    readLiveChatMessagesFromFile,
    type LiveChatMessageItem,
} from "../services/live-chat-service";
import { logError } from "../utils/app-logger";
import { resolveErrorMessage } from "../utils/error-message";

type UseMediaLiveChatResult = {
    liveChatMessages: LiveChatMessageItem[];
    isLoadingLiveChat: boolean;
    // Non-null only when the read actually failed, so the panel can tell a failed read apart from
    // "this media genuinely has no live chat" instead of silently rendering the empty state for a
    // transient disk or gzip-decode error on the replay file.
    error: string | null;
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
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function loadLiveChat(): Promise<void> {
            if (!media?.id || !media.live_chat_file_path?.trim() || !media.has_live_chat) {
                setLiveChatMessages([]);
                setError(null);
                setIsLoadingLiveChat(false);
                return;
            }

            setIsLoadingLiveChat(true);
            setError(null);

            try {
                const rows = await readLiveChatMessagesFromFile(media.live_chat_file_path);

                if (!cancelled) {
                    setLiveChatMessages(rows);
                }
            } catch (loadFailure) {
                if (!cancelled) {
                    setLiveChatMessages([]);
                    setError(
                        resolveErrorMessage(
                            loadFailure,
                            "Could not load the live chat replay for this media."
                        )
                    );
                }

                logError("media-player", "Failed to load live chat replay from file.", loadFailure, {
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

    return { liveChatMessages, isLoadingLiveChat, error };
}
