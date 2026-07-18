import { useEffect, useMemo, useState } from "react";
import {
    extractLiveChatPins,
    getActiveLiveChatPinFromPins,
    getVisibleLiveChatMessages,
    type LiveChatMessageItem,
} from "../../services/live-chat-service";
import { LiveChatPanel } from "./live-chat-panel";

// timeupdate fires ~4x/second during playback; collapsing it to at most one update per this
// window keeps the replay in sync without re-rendering the chat list on every tick.
const PLAYBACK_SYNC_THROTTLE_MS = 300;

type LiveChatReplayProps = {
    liveChatMessages: LiveChatMessageItem[];
    playerElement: HTMLMediaElement | null;
    isLoadingLiveChat: boolean;
    error?: string | null;
    shellBorder: string;
};

// Owns the playback-time subscription so a playing video only re-renders the chat list,
// not the whole player view (media surface + comments panel). The visible window is derived
// with a memoized binary search over the already-sorted messages.
export function LiveChatReplay({
    liveChatMessages,
    playerElement,
    isLoadingLiveChat,
    error = null,
    shellBorder,
}: LiveChatReplayProps): JSX.Element {
    const [currentPlaybackTime, setCurrentPlaybackTime] = useState(0);

    useEffect(() => {
        if (!playerElement) {
            setCurrentPlaybackTime(0);
            return;
        }

        let lastSyncedAt = 0;

        const applyCurrentTime = (): void => {
            setCurrentPlaybackTime(playerElement.currentTime || 0);
        };

        // Throttle the high-frequency timeupdate stream, but sync immediately on the
        // discrete events (seek, play, pause, metadata) so scrubbing stays responsive.
        const handleTimeUpdate = (): void => {
            const now = performance.now();

            if (now - lastSyncedAt < PLAYBACK_SYNC_THROTTLE_MS) {
                return;
            }

            lastSyncedAt = now;
            applyCurrentTime();
        };

        const handleImmediate = (): void => {
            lastSyncedAt = performance.now();
            applyCurrentTime();
        };

        const immediateEvents = ["seeking", "seeked", "play", "pause", "loadedmetadata"] as const;

        applyCurrentTime();

        playerElement.addEventListener("timeupdate", handleTimeUpdate);
        for (const eventName of immediateEvents) {
            playerElement.addEventListener(eventName, handleImmediate);
        }

        return () => {
            playerElement.removeEventListener("timeupdate", handleTimeUpdate);
            for (const eventName of immediateEvents) {
                playerElement.removeEventListener(eventName, handleImmediate);
            }
        };
    }, [playerElement]);

    const visibleLiveChatMessages = useMemo(
        () => getVisibleLiveChatMessages(liveChatMessages, currentPlaybackTime),
        [liveChatMessages, currentPlaybackTime]
    );

    // The pins are extracted once per message list (not per playback tick), so the active-pin
    // lookup below stays a binary search over this small array instead of re-scanning every message
    // each tick.
    const liveChatPins = useMemo(
        () => extractLiveChatPins(liveChatMessages),
        [liveChatMessages]
    );

    // Derived here, from the full pin list, rather than inside the panel from the capped visible
    // window: a pin that was set more than a visible-window ago is no longer in that window but is
    // still the active pin, and deriving it from the window would make the banner disappear.
    const activePin = useMemo(
        () => getActiveLiveChatPinFromPins(liveChatPins, currentPlaybackTime),
        [liveChatPins, currentPlaybackTime]
    );

    return (
        <LiveChatPanel
            liveChatMessages={liveChatMessages}
            visibleLiveChatMessages={visibleLiveChatMessages}
            activePin={activePin}
            isLoadingLiveChat={isLoadingLiveChat}
            error={error}
            shellBorder={shellBorder}
        />
    );
}
