import { useEffect, type RefObject } from "react";

function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const tagName = target.tagName.toLowerCase();

    return (
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        tagName === "button" ||
        target.isContentEditable
    );
}

// Wires the player's global keyboard shortcuts (Space play/pause, left/right seek, up/down volume,
// M mute, F fullscreen) to whatever element `playerElementRef` currently points at. The handler reads the
// ref fresh on every keypress, so it is subscribed once for the player's lifetime rather than
// re-subscribing per media. Shortcuts are suppressed while typing in a form field or while a
// modal is open on top of the player. Extracted from MediaPlayerView to keep the (sizeable)
// keyboard wiring out of the component body.
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
                    // interrupts the pending play() - which rejects with AbortError. That is the
                    // shortcut working, not a failure. Left unhandled it reached the
                    // unhandledrejection listener, which logs a *fatal* error to the rolling file
                    // log: an ordinary double-tap would dilute the one log that survives a webview
                    // crash and lands in bug reports. Anything else still surfaces.
                    if (!(error instanceof DOMException) || error.name !== "AbortError") {
                        throw error;
                    }
                }

                return;
            }

            element.pause();
        };

        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.repeat) {
                return;
            }

            if (event.ctrlKey || event.metaKey || event.altKey) {
                return;
            }

            // A modal is open on top of the player (Mantine marks it aria-modal). Don't let
            // these shortcuts drive the video hidden behind it.
            if (document.querySelector('[aria-modal="true"]')) {
                return;
            }

            if (isTypingTarget(event.target)) {
                return;
            }

            const element = playerElementRef.current;

            if (!element) {
                return;
            }

            switch (event.code) {
                case "Space":
                    event.preventDefault();
                    void togglePlayback();
                    break;
                case "ArrowLeft":
                    event.preventDefault();
                    element.currentTime = Math.max(0, element.currentTime - 5);
                    break;
                case "ArrowRight":
                    event.preventDefault();
                    if (Number.isFinite(element.duration)) {
                        element.currentTime = Math.min(element.duration, element.currentTime + 5);
                    }
                    break;
                case "ArrowUp":
                    // Raising the volume also unmutes, matching how a raised volume implies the
                    // user wants to hear it (and how the native/YouTube players behave).
                    event.preventDefault();
                    element.muted = false;
                    element.volume = Math.min(1, element.volume + 0.05);
                    break;
                case "ArrowDown":
                    event.preventDefault();
                    element.volume = Math.max(0, element.volume - 0.05);
                    break;
                case "KeyM":
                    event.preventDefault();
                    element.muted = !element.muted;
                    break;
                case "KeyF":
                    if (element instanceof HTMLVideoElement) {
                        event.preventDefault();
                        if (document.fullscreenElement) {
                            void document.exitFullscreen();
                        } else {
                            void element.requestFullscreen();
                        }
                    }
                    break;
            }
        };

        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [playerElementRef]);
}
