import { useCallback, useMemo } from "react";
import type {
    ChannelsController,
    DiagnosticsController,
    HomeMediaActionsController,
    MediaLibraryController,
} from "../types/controllers";
import type { MediaRow } from "../types/media";

type UseHomeMediaActionsOptions = {
    diagnosticsState: DiagnosticsController;
    mediaLibrary: MediaLibraryController;
    channelsState: Pick<ChannelsController, "selectedChannelId">;
    confirmDeleteChannelFlow: () => Promise<void>;
};

export function useHomeMediaActions({
    diagnosticsState,
    mediaLibrary,
    confirmDeleteChannelFlow,
}: UseHomeMediaActionsOptions): HomeMediaActionsController {
    const refreshDiagnosticsIfOpen = useCallback(async (): Promise<void> => {
        if (!diagnosticsState.diagnosticsOpen) {
            return;
        }

        await diagnosticsState.reloadDiagnostics();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the specific fields read inside, not the whole per-render diagnosticsState object
    }, [diagnosticsState.diagnosticsOpen, diagnosticsState.reloadDiagnostics]);

    const runActionAndRefreshDiagnostics = useCallback(
        async (action: () => Promise<void>): Promise<void> => {
            await action();
            await refreshDiagnosticsIfOpen();
        },
        [refreshDiagnosticsIfOpen]
    );

    const addMedia = useCallback(async (): Promise<void> => {
        await runActionAndRefreshDiagnostics(mediaLibrary.addMedia);
    }, [mediaLibrary.addMedia, runActionAndRefreshDiagnostics]);

    const confirmDeleteMedia = useCallback(async (): Promise<void> => {
        await runActionAndRefreshDiagnostics(mediaLibrary.confirmDeleteMedia);
    }, [mediaLibrary.confirmDeleteMedia, runActionAndRefreshDiagnostics]);

    const confirmDeleteChannel = useCallback(async (): Promise<void> => {
        await runActionAndRefreshDiagnostics(confirmDeleteChannelFlow);
    }, [confirmDeleteChannelFlow, runActionAndRefreshDiagnostics]);

    const markAsWatched = useCallback(
        async (mediaId: number): Promise<void> => {
            await runActionAndRefreshDiagnostics(() => mediaLibrary.markAsWatched(mediaId));
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dep is the specific stable callback read inside, not the whole per-render mediaLibrary object
        [mediaLibrary.markAsWatched, runActionAndRefreshDiagnostics]
    );

    const markAsUnwatched = useCallback(
        async (mediaId: number): Promise<void> => {
            await runActionAndRefreshDiagnostics(() => mediaLibrary.markAsUnwatched(mediaId));
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dep is the specific stable callback read inside, not the whole per-render mediaLibrary object
        [mediaLibrary.markAsUnwatched, runActionAndRefreshDiagnostics]
    );

    const editMediaTitle = useCallback(
        async (media: MediaRow, title: string): Promise<void> => {
            await runActionAndRefreshDiagnostics(() => mediaLibrary.editTitle(media, title));
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dep is the specific stable callback read inside, not the whole per-render mediaLibrary object
        [mediaLibrary.editTitle, runActionAndRefreshDiagnostics]
    );

    const saveMediaProgress = useCallback(
        async (mediaId: number, progressSeconds: number): Promise<void> => {
            await runActionAndRefreshDiagnostics(() =>
                mediaLibrary.saveMediaProgress(mediaId, progressSeconds)
            );
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dep is the specific stable callback read inside, not the whole per-render mediaLibrary object
        [mediaLibrary.saveMediaProgress, runActionAndRefreshDiagnostics]
    );

    return useMemo(
        () => ({
            addMedia,
            confirmDeleteMedia,
            confirmDeleteChannel,
            markAsWatched,
            markAsUnwatched,
            editMediaTitle,
            saveMediaProgress,
        }),
        [
            addMedia,
            confirmDeleteMedia,
            confirmDeleteChannel,
            markAsWatched,
            markAsUnwatched,
            editMediaTitle,
            saveMediaProgress,
        ]
    );
}