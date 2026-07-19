import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useModalLock } from "./use-modal-lock";
import { NOOP } from "../utils/noop";

describe("useModalLock", () => {
    it("passes the real onClose and enables every dismissal path when unlocked", () => {
        const onClose = vi.fn();

        const { result } = renderHook(() => useModalLock(false, onClose));

        expect(result.current.onClose).toBe(onClose);
        expect(result.current.closeOnClickOutside).toBe(true);
        expect(result.current.closeOnEscape).toBe(true);
        expect(result.current.withCloseButton).toBe(true);
    });

    it("swaps onClose for a no-op and disables every dismissal path when locked", () => {
        const onClose = vi.fn();

        const { result } = renderHook(() => useModalLock(true, onClose));

        // The lock must neutralize onClose (not merely disable the visible controls) so a Mantine
        // internal close path cannot still fire the real handler mid-operation.
        expect(result.current.onClose).toBe(NOOP);
        expect(result.current.onClose).not.toBe(onClose);
        expect(result.current.closeOnClickOutside).toBe(false);
        expect(result.current.closeOnEscape).toBe(false);
        expect(result.current.withCloseButton).toBe(false);
    });

    it("keeps a stable props identity until locked or onClose changes", () => {
        const onClose = vi.fn();

        const { result, rerender } = renderHook(
            ({ locked }: { locked: boolean }) => useModalLock(locked, onClose),
            { initialProps: { locked: false } }
        );

        const first = result.current;

        // Same inputs -> same object, so a Modal consuming these props is not re-triggered.
        rerender({ locked: false });
        expect(result.current).toBe(first);

        // Flipping the lock produces a new props object reflecting the change.
        rerender({ locked: true });
        expect(result.current).not.toBe(first);
        expect(result.current.onClose).toBe(NOOP);
    });
});
