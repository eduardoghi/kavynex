import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useHomeMediaTitleEditing } from "./use-home-media-title-editing";
import { createMedia } from "../test/factories/media";

describe("useHomeMediaTitleEditing", () => {
    it("starts closed and not saving", () => {
        const { result } = renderHook(() =>
            useHomeMediaTitleEditing({ editMediaTitle: vi.fn().mockResolvedValue(undefined) })
        );

        expect(result.current.editTitleMedia).toBeNull();
        expect(result.current.isSavingTitle).toBe(false);
    });

    it("opens the modal on edit and closes it on cancel", () => {
        const media = createMedia({ id: 3 });
        const { result } = renderHook(() =>
            useHomeMediaTitleEditing({ editMediaTitle: vi.fn().mockResolvedValue(undefined) })
        );

        act(() => {
            result.current.handleEditTitle(media);
        });
        expect(result.current.editTitleMedia).toBe(media);

        act(() => {
            result.current.closeEditTitle();
        });
        expect(result.current.editTitleMedia).toBeNull();
    });

    it("saves, then closes the modal and clears the saving flag on success", async () => {
        const media = createMedia({ id: 9 });
        const editMediaTitle = vi.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useHomeMediaTitleEditing({ editMediaTitle }));

        act(() => {
            result.current.handleEditTitle(media);
        });

        await act(async () => {
            await result.current.handleSaveMediaTitle(media, "New title");
        });

        expect(editMediaTitle).toHaveBeenCalledWith(media, "New title");
        expect(result.current.editTitleMedia).toBeNull();
        expect(result.current.isSavingTitle).toBe(false);
    });

    it("keeps the modal open and clears the saving flag when the save fails", async () => {
        const media = createMedia({ id: 11 });
        const editMediaTitle = vi.fn().mockRejectedValue(new Error("boom"));
        const { result } = renderHook(() => useHomeMediaTitleEditing({ editMediaTitle }));

        act(() => {
            result.current.handleEditTitle(media);
        });

        await act(async () => {
            // The rejection propagates to the caller (the modal's onSave), which surfaces the error;
            // the hook's job is only to leave the edit intact and stop the spinner.
            await expect(result.current.handleSaveMediaTitle(media, "New title")).rejects.toThrow(
                "boom"
            );
        });

        await waitFor(() => expect(result.current.isSavingTitle).toBe(false));
        expect(result.current.editTitleMedia).toBe(media);
    });
});
