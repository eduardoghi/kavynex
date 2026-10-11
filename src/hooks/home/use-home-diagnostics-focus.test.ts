import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHomeDiagnosticsFocus } from "./use-home-diagnostics-focus";

function setup(isPlayerOpen = false) {
    const closeDiagnostics = vi.fn();
    const setSelectedChannelId = vi.fn();
    const closePlayer = vi.fn();

    const { result } = renderHook(() =>
        useHomeDiagnosticsFocus({
            closeDiagnostics,
            setSelectedChannelId,
            isPlayerOpen,
            closePlayer,
        })
    );

    return { result, closeDiagnostics, setSelectedChannelId, closePlayer };
}

describe("useHomeDiagnosticsFocus", () => {
    it("closes the player first, so the grid it hid can take the focus", () => {
        const open = setup(true);

        act(() => {
            open.result.current.handleOpenDiagnosticsMedia({ channelId: 7, mediaId: 42 });
        });

        expect(open.closePlayer).toHaveBeenCalledTimes(1);

        const closed = setup(false);

        act(() => {
            closed.result.current.handleOpenDiagnosticsMedia({ channelId: 7, mediaId: 42 });
        });

        expect(closed.closePlayer).not.toHaveBeenCalled();
    });

    it("starts with no focused media", () => {
        const { result } = setup();
        expect(result.current.focusMediaId).toBeNull();
    });

    it("closes diagnostics, selects the channel and focuses the media on open", () => {
        const { result, closeDiagnostics, setSelectedChannelId } = setup();

        act(() => {
            result.current.handleOpenDiagnosticsMedia({ channelId: 7, mediaId: 42 });
        });

        expect(closeDiagnostics).toHaveBeenCalledTimes(1);
        expect(setSelectedChannelId).toHaveBeenCalledWith(7);
        expect(result.current.focusMediaId).toBe(42);
    });

    it("clears the focused media once the grid has handled it", () => {
        const { result } = setup();

        act(() => {
            result.current.handleOpenDiagnosticsMedia({ channelId: 1, mediaId: 5 });
        });
        expect(result.current.focusMediaId).toBe(5);

        act(() => {
            result.current.handleFocusMediaHandled();
        });
        expect(result.current.focusMediaId).toBeNull();
    });
});
