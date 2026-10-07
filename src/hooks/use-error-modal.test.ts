import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useErrorModal } from "./use-error-modal";

describe("useErrorModal", () => {
    it("starts closed with empty message", () => {
        const { result } = renderHook(() => useErrorModal());

        expect(result.current.errorOpen).toBe(false);
        expect(result.current.errorMessage).toBe("");
    });

    it("opens modal with provided message as an error", () => {
        const { result } = renderHook(() => useErrorModal());

        act(() => {
            result.current.showError("Something failed");
        });

        expect(result.current.errorOpen).toBe(true);
        expect(result.current.errorMessage).toBe("Something failed");
        expect(result.current.errorVariant).toBe("error");
    });

    it("opens modal as a notice for non-error messages", () => {
        const { result } = renderHook(() => useErrorModal());

        act(() => {
            result.current.showNotice("Nothing to worry about");
        });

        expect(result.current.errorOpen).toBe(true);
        expect(result.current.errorMessage).toBe("Nothing to worry about");
        expect(result.current.errorVariant).toBe("notice");
    });

    it("closes modal and clears message", () => {
        const { result } = renderHook(() => useErrorModal());

        act(() => {
            result.current.showError("Something failed");
        });

        act(() => {
            result.current.closeErrorModal();
        });

        expect(result.current.errorOpen).toBe(false);
        expect(result.current.errorMessage).toBe("");
    });

    it("keeps an open error on screen when a notice arrives, and shows the notice next", () => {
        const { result } = renderHook(() => useErrorModal());

        act(() => {
            result.current.showError("The download failed");
            result.current.showNotice("No comments were found");
        });

        expect(result.current.errorMessage).toBe("The download failed");
        expect(result.current.errorVariant).toBe("error");
        expect(result.current.pendingMessageCount).toBe(1);

        act(() => {
            result.current.closeErrorModal();
        });

        expect(result.current.errorOpen).toBe(true);
        expect(result.current.errorMessage).toBe("No comments were found");
        expect(result.current.errorVariant).toBe("notice");
        expect(result.current.pendingMessageCount).toBe(0);

        act(() => {
            result.current.closeErrorModal();
        });

        expect(result.current.errorOpen).toBe(false);
        expect(result.current.errorMessage).toBe("");
    });

    it("queues a message that is already waiting only once", () => {
        const { result } = renderHook(() => useErrorModal());

        act(() => {
            result.current.showError("Network error");
            result.current.showError("Network error");
            result.current.showNotice("Network error");
        });

        // The same text as a notice is a different message.
        expect(result.current.pendingMessageCount).toBe(1);
    });

    it("stops queueing past the cap and keeps the earliest messages", () => {
        const { result } = renderHook(() => useErrorModal());

        act(() => {
            for (let index = 0; index < 25; index += 1) {
                result.current.showError(`Failure ${index}`);
            }
        });

        expect(result.current.errorMessage).toBe("Failure 0");
        expect(result.current.pendingMessageCount).toBe(19);
    });

    it("keeps a stable showError reference across rerenders", () => {
        const { result, rerender } = renderHook(() => useErrorModal());

        const firstShowError = result.current.showError;

        rerender();

        expect(result.current.showError).toBe(firstShowError);
    });

    it("keeps a stable closeErrorModal reference across rerenders", () => {
        const { result, rerender } = renderHook(() => useErrorModal());

        const firstCloseErrorModal = result.current.closeErrorModal;

        rerender();

        expect(result.current.closeErrorModal).toBe(firstCloseErrorModal);
    });

    it("keeps stable callback references even after state changes", () => {
        const { result, rerender } = renderHook(() => useErrorModal());

        const firstShowError = result.current.showError;
        const firstCloseErrorModal = result.current.closeErrorModal;

        act(() => {
            result.current.showError("Something failed");
        });

        rerender();

        expect(result.current.showError).toBe(firstShowError);
        expect(result.current.closeErrorModal).toBe(firstCloseErrorModal);
    });
});