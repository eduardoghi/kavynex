import { useCallback } from "react";
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
    }, [diagnosticsState]);

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
        [mediaLibrary, runActionAndRefreshDiagnostics]
    );

    const markAsUnwatched = useCallback(
        async (mediaId: number): Promise<void> => {
            await runActionAndRefreshDiagnostics(() => mediaLibrary.markAsUnwatched(mediaId));
        },
        [mediaLibrary, runActionAndRefreshDiagnostics]
    );

    const editMediaTitle = useCallback(
        async (media: MediaRow, title: string): Promise<void> => {
            await runActionAndRefreshDiagnostics(() => mediaLibrary.editTitle(media, title));
        },
        [mediaLibrary, runActionAndRefreshDiagnostics]
    );

    const saveMediaProgress = useCallback(
        async (mediaId: number, progressSeconds: number): Promise<void> => {
            await runActionAndRefreshDiagnostics(() =>
                mediaLibrary.saveMediaProgress(mediaId, progressSeconds)
            );
        },
        [mediaLibrary, runActionAndRefreshDiagnostics]
    );

    return {
        addMedia,
        confirmDeleteMedia,
        confirmDeleteChannel,
        markAsWatched,
        markAsUnwatched,
        editMediaTitle,
        saveMediaProgress,
    };
}