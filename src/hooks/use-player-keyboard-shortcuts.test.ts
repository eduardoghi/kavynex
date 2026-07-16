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
        // rejects that play() with AbortError - the shortcut working as intended. The handler
        // calls togglePlayback with `void`, so an escaping rejection is unhandled: in the app it
        // reaches the unhandledrejection listener and is written to the file log as a *fatal*
        // error, meaning an ordinary double-tap pollutes the log that ships in bug reports.
        //
        // What fails this test if the guard is dropped is Vitest itself, which reports an
        // unhandled rejection as an error and fails the run (verified by removing the guard: the
        // run reports "Unhandled Rejection: AbortError: interrupted" against this test). A
        // window-level listener cannot assert it - jsdom does not dispatch the event - so an
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
});
