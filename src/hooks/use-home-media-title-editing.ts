import { useCallback, useState } from "react";
import type { MediaRow } from "../types/media";

type UseHomeMediaTitleEditingOptions = {
    editMediaTitle: (media: MediaRow, title: string) => Promise<void>;
};

export type HomeMediaTitleEditing = {
    // The media whose title is being edited, or null when the edit modal is closed.
    editTitleMedia: MediaRow | null;
    isSavingTitle: boolean;
    handleEditTitle: (item: MediaRow) => void;
    closeEditTitle: () => void;
    handleSaveMediaTitle: (item: MediaRow, title: string) => Promise<void>;
};

// Owns the edit-media-title modal flow: which media is open in the modal, the in-flight save state,
// and the save itself (which closes the modal only after the rename succeeds, leaving it open with
// the typed title on failure so the error surfaces without losing the edit). Lifted out of the Home
// page component so this async orchestration lives in a hook rather than inline in the page body.
export function useHomeMediaTitleEditing({
    editMediaTitle,
}: UseHomeMediaTitleEditingOptions): HomeMediaTitleEditing {
    const [editTitleMedia, setEditTitleMedia] = useState<MediaRow | null>(null);
    const [isSavingTitle, setIsSavingTitle] = useState(false);

    const handleEditTitle = useCallback((item: MediaRow): void => {
        setEditTitleMedia(item);
    }, []);

    const closeEditTitle = useCallback((): void => {
        setEditTitleMedia(null);
    }, []);

    const handleSaveMediaTitle = useCallback(
        async (item: MediaRow, title: string): Promise<void> => {
            setIsSavingTitle(true);

            try {
                await editMediaTitle(item, title);
                setEditTitleMedia(null);
            } finally {
                setIsSavingTitle(false);
            }
        },
        [editMediaTitle]
    );

    return {
        editTitleMedia,
        isSavingTitle,
        handleEditTitle,
        closeEditTitle,
        handleSaveMediaTitle,
    };
}
