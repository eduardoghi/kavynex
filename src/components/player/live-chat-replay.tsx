import { useEffect, useMemo, useRef, useState } from "react";
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
    // Whether the chat live region should announce newly revealed messages to a screen reader.
    // On during ordinary playback; turned off across a seek / new-video load, where the whole
    // visible window is replaced at once (see the handlers below).
    const [announceAdditions, setAnnounceAdditions] = useState(true);
    // True from a "seeking" event until its matching "seeked" fires. Some engines emit a
    // timeupdate in that window - mid-scrub, before the seek has actually settled - and
    // handleTimeUpdate must not treat that as ordinary playback and re-enable announcements while
    // the seek is still in flight: doing so let up to ~200 messages announce as a burst once the
    // seek finally landed, because announcements were back on before the jump happened.
    const isSeekingRef = useRef(false);

    useEffect(() => {
        if (!playerElement) {
            setCurrentPlaybackTime(0);
            return;
        }

        let lastSyncedAt = 0;
        isSeekingRef.current = false;

        const applyCurrentTime = (): void => {
            setCurrentPlaybackTime(playerElement.currentTime || 0);
        };

        // Throttle the high-frequency timeupdate stream. This is ordinary forward playback, where
        // messages scroll in one at a time, so re-enable live-region announcements here - unless a
        // seek is still in flight (isSeekingRef), in which case this is a stray mid-scrub event
        // that must not flip announcements back on before the seek actually settles.
        const handleTimeUpdate = (): void => {
            const now = performance.now();

            if (now - lastSyncedAt < PLAYBACK_SYNC_THROTTLE_MS) {
                return;
            }

            lastSyncedAt = now;

            if (!isSeekingRef.current) {
                setAnnounceAdditions(true);
            }

            applyCurrentTime();
        };

        // A seek or a new-video load replaces most or all of the (up to 200) visible messages in a
        // single commit. Announcing that swap would flood the screen reader with a burst of "new"
        // messages that is really a jump, not live chat activity - so suppress announcements across
        // it. The next incremental timeupdate re-enables them, so only genuine playback additions
        // past the seek point are ever announced.
        const handleSeekOrReload = (): void => {
            lastSyncedAt = performance.now();
            setAnnounceAdditions(false);
            applyCurrentTime();
        };

        // Marks a seek as in flight, so a stray timeupdate mid-scrub cannot re-enable
        // announcements before the seek settles (see isSeekingRef above).
        const handleSeekStart = (): void => {
            isSeekingRef.current = true;
            handleSeekOrReload();
        };

        // The seek has settled - clear the in-flight flag so the next ordinary timeupdate can
        // re-enable announcements as usual.
        const handleSeekEnd = (): void => {
            isSeekingRef.current = false;
            handleSeekOrReload();
        };

        // A fresh video load is never mid-seek.
        const handleReload = (): void => {
            isSeekingRef.current = false;
            handleSeekOrReload();
        };

        // play/pause do not jump the playback position, so they only need a resync, never a change
        // to the announcement state.
        const handlePlaybackStateChange = (): void => {
            lastSyncedAt = performance.now();
            applyCurrentTime();
        };

        const playbackStateEvents = ["play", "pause"] as const;

        applyCurrentTime();

        playerElement.addEventListener("timeupdate", handleTimeUpdate);
        playerElement.addEventListener("seeking", handleSeekStart);
        playerElement.addEventListener("seeked", handleSeekEnd);
        playerElement.addEventListener("loadedmetadata", handleReload);
        for (const eventName of playbackStateEvents) {
            playerElement.addEventListener(eventName, handlePlaybackStateChange);
        }

        return () => {
            playerElement.removeEventListener("timeupdate", handleTimeUpdate);
            playerElement.removeEventListener("seeking", handleSeekStart);
            playerElement.removeEventListener("seeked", handleSeekEnd);
            playerElement.removeEventListener("loadedmetadata", handleReload);
            for (const eventName of playbackStateEvents) {
                playerElement.removeEventListener(eventName, handlePlaybackStateChange);
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
            announceAdditions={announceAdditions}
            shellBorder={shellBorder}
        />
    );
}
