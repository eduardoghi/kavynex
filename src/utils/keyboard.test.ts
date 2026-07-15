import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { activateOnEnterOrSpace } from "./keyboard";

function keyboardEvent(key: string): KeyboardEvent {
    return {
        key,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
}

describe("activateOnEnterOrSpace", () => {
    it("activates and prevents default on Enter", () => {
        const onActivate = vi.fn();
        const event = keyboardEvent("Enter");

        activateOnEnterOrSpace(onActivate)(event);

        expect(onActivate).toHaveBeenCalledTimes(1);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("activates and prevents default (page scroll) on Space", () => {
        const onActivate = vi.fn();
        const event = keyboardEvent(" ");

        activateOnEnterOrSpace(onActivate)(event);

        expect(onActivate).toHaveBeenCalledTimes(1);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    it("claims the key so a global shortcut does not also act on it", () => {
        // These controls live inside the player, whose shortcuts listen on `document` and only
        // skip real form fields. Without stopPropagation, Space on an author link would open the
        // channel and toggle play/pause on the video behind it.
        for (const key of ["Enter", " "]) {
            const event = keyboardEvent(key);

            activateOnEnterOrSpace(vi.fn())(event);

            expect(event.stopPropagation).toHaveBeenCalledTimes(1);
        }
    });

    it("ignores other keys without preventing default or stopping propagation", () => {
        const onActivate = vi.fn();
        const event = keyboardEvent("a");

        activateOnEnterOrSpace(onActivate)(event);

        expect(onActivate).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
    });
});
