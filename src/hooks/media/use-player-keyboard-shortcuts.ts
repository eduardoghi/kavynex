import { useEffect, type RefObject } from "react";
import { logError } from "../../utils/app-logger";

// True when no other element has a claim on the key. Focus is on the player itself, or on nothing,
// which is the body (where focus lands after a click on content that cannot take it). Anything else
// focused keeps its own keys: a field types, a button presses, a slider moves, and a focusable
// scroll area (the comments, the live chat replay) scrolls with Space and the arrows.
function isPlayerShortcutTarget(
    target: EventTarget | null,
    player: HTMLMediaElement
): boolean {
    if (target === document || target === document.body) {
        return true;
    }

    return target instanceof Node && player.contains(target);
}

// Wires the player's global keyboard shortcuts (Space play/pause, left/right seek, up/down volume,
// M mute, F fullscreen) to whatever element `playerElementRef` currently points at. The handler reads the
// ref fresh on every keypress, so it is subscribed once for the player's lifetime rather than
// re-subscribing per media. Shortcuts apply only while focus is on the player or on nothing (see
// isPlayerShortcutTarget), and never while a modal is open on top of the player. Extracted from MediaPlayerView to keep the (sizeable)
// keyboard wiring out of the component body.
//
// The listener is registered in the **capture** phase, and that is load-bearing. The player is a
// `<video controls>`, and clicking its picture focuses it. A focused Chromium media element has
// keyboard handling of its own (Space toggles play, left/right seek by one percent of the duration,
// up/down step the volume by 0.05), which runs at the target *before* a bubble-phase listener on the
// document sees anything and decides whether to skip itself by whether the event is already
// defaultPrevented by then. So with a bubbling listener both ran: Space toggled twice and did
// nothing, a right arrow moved 5s plus the native percent, up moved the volume by 0.10, and holding
// an arrow scrubbed at the native step while this hook ignored the repeats. Measured on a headless
// Edge 152 (the WebView2 engine) with trusted key events over CDP, against a bubble listener that
// prevented the default: every native action still happened. In capture, none did. So a
// preventDefault here reaches the native handler in time, and it is issued on every key this hook
// owns, repeats included, so holding a key is inert everywhere rather than native-only while the
// player has focus.
//
// What this does not reach, measured in the same pass, is keyboard focus tabbed *into* the native
// controls (the play button, the mute button, the volume slider). A key pressed there never
// arrives at the document in either phase, so the control handles it alone, the way it did before,
// and nothing doubles up there either. The case this fixes is the host element itself having focus,
// which is what a click on the picture leaves behind.
export function usePlayerKeyboardShortcuts(
    playerElementRef: RefObject<HTMLMediaElement | null>
): void {
    useEffect(() => {
        const togglePlayback = async (): Promise<void> => {
            const element = playerElementRef.current;

            if (!element) {
                return;
            }

            if (element.paused) {
                try {
                    await element.play();
                } catch (error) {
                    // `paused` flips to false synchronously when play() is called, before its
                    // promise settles, so a fast second Space takes the pause() branch below and
                    // interrupts the pending play(), which rejects with AbortError. That is the
                    // shortcut working, not a failure.
                    //
                    // Anything else is logged here rather than left to reject. The key handler does
                    // not await this, so a rejection would reach the unhandledrejection listener,
                    // which logs a *fatal* error to the rolling file log, the one log that survives
                    // a webview crash and lands in bug reports. A media the webview cannot play is
                    // not that, and the player reports it through the element's own error state.
                    if (!(error instanceof DOMException) || error.name !== "AbortError") {
                        logError("player", "Failed to start playback from the keyboard.", error);
                    }
                }

                return;
            }

            element.pause();
        };

        // The action a key maps to, or null when the key is not one of ours. Resolved before
        // anything is prevented, so a key this hook does not own keeps its default everywhere.
        const actionFor = (code: string, element: HTMLMediaElement): (() => void) | null => {
            switch (code) {
                case "Space":
                    return () => {
                        void togglePlayback();
                    };
                case "ArrowLeft":
                    return () => {
                        element.currentTime = Math.max(0, element.currentTime - 5);
                    };
                case "ArrowRight":
                    return () => {
                        if (Number.isFinite(element.duration)) {
                            element.currentTime = Math.min(
                                element.duration,
                                element.currentTime + 5
                            );
                        }
                    };
                case "ArrowUp":
                    // Raising the volume also unmutes, matching how a raised volume implies the
                    // user wants to hear it (and how the native/YouTube players behave).
                    return () => {
                        element.muted = false;
                        element.volume = Math.min(1, element.volume + 0.05);
                    };
                case "ArrowDown":
                    return () => {
                        element.volume = Math.max(0, element.volume - 0.05);
                    };
                case "KeyM":
                    return () => {
                        element.muted = !element.muted;
                    };
                case "KeyF":
                    if (!(element instanceof HTMLVideoElement)) {
                        return null;
                    }

                    // Caught for the reason togglePlayback catches. The webview can refuse
                    // either call (fullscreen not allowed, the element detached meanwhile).
                    return () => {
                        const toggled = document.fullscreenElement
                            ? document.exitFullscreen()
                            : element.requestFullscreen();

                        toggled.catch((error: unknown) => {
                            logError(
                                "player",
                                "Failed to toggle fullscreen from the keyboard.",
                                error
                            );
                        });
                    };
                default:
                    return null;
            }
        };

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.ctrlKey || event.metaKey || event.altKey) {
                return;
            }

            // A modal is open on top of the player (Mantine marks it aria-modal). Don't let
            // these shortcuts drive the video hidden behind it.
            if (document.querySelector('[aria-modal="true"]')) {
                return;
            }

            const element = playerElementRef.current;

            if (!element || !isPlayerShortcutTarget(event.target, element)) {
                return;
            }

            const action = actionFor(event.code, element);

            if (!action) {
                return;
            }

            // Claimed before the repeat check on purpose. See the capture note above: the native
            // handler would otherwise act on every repeat this hook declines to.
            event.preventDefault();

            if (event.repeat) {
                return;
            }

            action();
        };

        document.addEventListener("keydown", handleKeyDown, true);

        return () => {
            document.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [playerElementRef]);
}
