import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayerKeyboardShortcuts } from "./use-player-keyboard-shortcuts";

type PlayerStub = {
    paused: boolean;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
};

function createPlayer(overrides: Partial<PlayerStub> = {}): PlayerStub {
    return {
        paused: true,
        play: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn(),
        ...overrides,
    };
}

function renderWithPlayer(player: PlayerStub) {
    const ref = { current: player as unknown as HTMLMediaElement };
    return renderHook(() => usePlayerKeyboardShortcuts(ref));
}

function pressSpace(): void {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
}

function pressKey(code: string): void {
    document.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true }));
}

// Lets the microtask the Space handler kicks off (`void togglePlayback()`) settle, so a
// rejection surfaces as an unhandled rejection rather than after the assertion.
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("usePlayerKeyboardShortcuts", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it("plays a paused player on Space", async () => {
        const player = createPlayer({ paused: true });
        renderWithPlayer(player);

        pressSpace();
        await flush();

        expect(player.play).toHaveBeenCalledTimes(1);
        expect(player.pause).not.toHaveBeenCalled();
    });

    it("pauses a playing player on Space", async () => {
        const player = createPlayer({ paused: false });
        renderWithPlayer(player);

        pressSpace();
        await flush();

        expect(player.pause).toHaveBeenCalledTimes(1);
        expect(player.play).not.toHaveBeenCalled();
    });

    it("swallows the AbortError a fast second Space causes", async () => {
        // `paused` flips to false synchronously when play() is called, before its promise
        // settles, so a fast second Space pauses and interrupts the pending play(). The browser
        // rejects that play() with AbortError. The shortcut working as intended. The handler
        // calls togglePlayback with `void`, so an escaping rejection is unhandled. In the app it
        // reaches the unhandledrejection listener and is written to the file log as a *fatal*
        // error, meaning an ordinary double-tap pollutes the log that ships in bug reports.
        //
        // What fails this test if the guard is dropped is Vitest itself, which reports an
        // unhandled rejection as an error and fails the run (verified by removing the guard. The
        // run reports "Unhandled Rejection: AbortError: interrupted" against this test). A
        // window-level listener cannot assert it (jsdom does not dispatch the event), so an
        // `expect(...)` here would pass whether or not the guard exists.
        const player = createPlayer({
            paused: true,
            play: vi.fn().mockRejectedValue(new DOMException("interrupted", "AbortError")),
        });
        renderWithPlayer(player);

        pressSpace();
        await flush();

        expect(player.play).toHaveBeenCalledTimes(1);
    });

    it("raises the volume and unmutes on ArrowUp, lowers it on ArrowDown", () => {
        const player = { volume: 0.5, muted: true, paused: false, play: vi.fn(), pause: vi.fn() };
        const ref = { current: player as unknown as HTMLMediaElement };
        renderHook(() => usePlayerKeyboardShortcuts(ref));

        pressKey("ArrowUp");
        expect(player.muted).toBe(false);
        expect(player.volume).toBeCloseTo(0.55);

        pressKey("ArrowDown");
        expect(player.volume).toBeCloseTo(0.5);
    });

    it("clamps the volume to at most 1 on ArrowUp", () => {
        const player = { volume: 0.98, muted: false, paused: false, play: vi.fn(), pause: vi.fn() };
        const ref = { current: player as unknown as HTMLMediaElement };
        renderHook(() => usePlayerKeyboardShortcuts(ref));

        pressKey("ArrowUp");
        pressKey("ArrowUp");
        expect(player.volume).toBe(1);
    });

    it("ignores Space while typing in a form field", async () => {
        const player = createPlayer({ paused: true });
        renderWithPlayer(player);

        const input = document.createElement("input");
        document.body.appendChild(input);
        input.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
        await flush();

        expect(player.play).not.toHaveBeenCalled();

        input.remove();
    });

    // The three below pin the capture-phase subscription and what it is for. A real
    // `<video controls>` that has focus handles Space and the arrows itself, at the target, and
    // skips that only when the event is already defaultPrevented by the time it looks. jsdom has
    // no media controls, so what can be asserted here is the mechanism: the listener runs in
    // capture, it prevents the default on the player element itself, and it keeps preventing on
    // repeats it otherwise ignores. The end-to-end effect (one toggle, a 5s seek, a 0.05 volume
    // step, with the player element focused) was measured in a Chromium build with trusted key
    // events; see the hook's comment.
    it("subscribes in the capture phase, so it runs before the player's own handling", () => {
        const addSpy = vi.spyOn(document, "addEventListener");
        const removeSpy = vi.spyOn(document, "removeEventListener");
        const player = createPlayer();
        const { unmount } = renderWithPlayer(player);

        const subscription = addSpy.mock.calls.find(([type]) => type === "keydown");
        expect(subscription?.[2]).toBe(true);

        unmount();

        const removal = removeSpy.mock.calls.find(([type]) => type === "keydown");
        expect(removal?.[2]).toBe(true);
    });

    it("claims a shortcut pressed on the focused player element before the browser acts on it", () => {
        const video = document.createElement("video");
        document.body.appendChild(video);
        const ref = { current: video };
        Object.defineProperty(video, "duration", { value: 60, configurable: true });
        renderHook(() => usePlayerKeyboardShortcuts(ref));

        const seek = new KeyboardEvent("keydown", {
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
        });
        video.dispatchEvent(seek);

        // Both halves. The default is prevented (which is what stops the native percent-of-duration
        // seek) and the hook's own 5s seek happened instead.
        expect(seek.defaultPrevented).toBe(true);
        expect(video.currentTime).toBe(5);

        // A key the hook does not own keeps its default, wherever it lands.
        const unowned = new KeyboardEvent("keydown", {
            code: "KeyK",
            bubbles: true,
            cancelable: true,
        });
        video.dispatchEvent(unowned);
        expect(unowned.defaultPrevented).toBe(false);

        video.remove();
    });

    it("prevents the default on a held key without repeating the action", () => {
        const video = document.createElement("video");
        document.body.appendChild(video);
        const ref = { current: video };
        Object.defineProperty(video, "duration", { value: 60, configurable: true });
        renderHook(() => usePlayerKeyboardShortcuts(ref));

        const repeat = new KeyboardEvent("keydown", {
            code: "ArrowRight",
            bubbles: true,
            cancelable: true,
            repeat: true,
        });
        video.dispatchEvent(repeat);

        // Ignoring the repeat is the existing behavior. Preventing it anyway is what keeps the
        // native handler from scrubbing on every repeat while the player has focus, so a held
        // arrow does the same thing whichever element has focus, which is nothing.
        expect(repeat.defaultPrevented).toBe(true);
        expect(video.currentTime).toBe(0);

        video.remove();
    });
});
