import { describe, expect, it } from "vitest";
import { SUPPRESS_FOCUS_RING_ATTRIBUTE, suppressFocusRingOnce } from "./focus-ring";

function createButton(): HTMLButtonElement {
    const button = document.createElement("button");
    document.body.appendChild(button);
    return button;
}

describe("suppressFocusRingOnce", () => {
    it("marks the element so the ring rule can opt it out", () => {
        const button = createButton();

        suppressFocusRingOnce(button);

        expect(button.hasAttribute(SUPPRESS_FOCUS_RING_ATTRIBUTE)).toBe(true);
    });

    it("releases the mark on the next keydown", () => {
        // The suppression covers the programmatic restore, never the user's own navigation: as soon
        // as they press a key on the restored card, the ring has to come back.
        const button = createButton();
        suppressFocusRingOnce(button);

        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));

        expect(button.hasAttribute(SUPPRESS_FOCUS_RING_ATTRIBUTE)).toBe(false);
    });

    it("releases the mark when the element loses focus", () => {
        const button = createButton();
        suppressFocusRingOnce(button);

        button.dispatchEvent(new FocusEvent("blur"));

        expect(button.hasAttribute(SUPPRESS_FOCUS_RING_ATTRIBUTE)).toBe(false);
    });

    it("detaches both listeners once released, so nothing lingers on the element", () => {
        // The card outlives the player it was restored from, so a listener left attached would
        // accumulate one pair per open/close cycle.
        const button = createButton();
        suppressFocusRingOnce(button);

        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
        // Re-marked by hand: if the listeners were still attached, this event would clear it again.
        button.setAttribute(SUPPRESS_FOCUS_RING_ATTRIBUTE, "");
        button.dispatchEvent(new FocusEvent("blur"));

        expect(button.hasAttribute(SUPPRESS_FOCUS_RING_ATTRIBUTE)).toBe(true);
    });

    it("re-arms cleanly when the same element is restored again", () => {
        // Open the player from the same card twice: the second restore must suppress the ring just
        // like the first, rather than being swallowed by leftover state.
        const button = createButton();

        suppressFocusRingOnce(button);
        button.dispatchEvent(new FocusEvent("blur"));
        suppressFocusRingOnce(button);

        expect(button.hasAttribute(SUPPRESS_FOCUS_RING_ATTRIBUTE)).toBe(true);

        button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
        expect(button.hasAttribute(SUPPRESS_FOCUS_RING_ATTRIBUTE)).toBe(false);
    });
});
