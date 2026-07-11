import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { activateOnEnterOrSpace } from "./keyboard";

function keyboardEvent(key: string): KeyboardEvent {
    return {
        key,
        preventDefault: vi.fn(),
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

    it("ignores other keys without preventing default", () => {
        const onActivate = vi.fn();
        const event = keyboardEvent("a");

        activateOnEnterOrSpace(onActivate)(event);

        expect(onActivate).not.toHaveBeenCalled();
        expect(event.preventDefault).not.toHaveBeenCalled();
    });
});
