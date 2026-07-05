import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useErrorModal } from "./use-error-modal";

describe("useErrorModal", () => {
    it("starts closed with empty message", () => {
        const { result } = renderHook(() => useErrorModal());

        expect(result.current.errorOpen).toBe(false);
        expect(result.current.errorMessage).toBe("");
    });

    it("opens modal with provided message", () => {
        const { result } = renderHook(() => useErrorModal());

        act(() => {
            result.current.showError("Something failed");
        });

        expect(result.current.errorOpen).toBe(true);
        expect(result.current.errorMessage).toBe("Something failed");
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