import { useCallback } from "react";
import type {
    DiagnosticsController,
    HomeMediaActionsController,
    MediaLibraryController,
} from "../types/controllers";
import type { MediaRow } from "../types/media";
import { useMemoObject } from "./use-memo-object";

type UseHomeMediaActionsOptions = {
    diagnosticsState: DiagnosticsController;
    mediaLibrary: MediaLibraryController;
    confirmDeleteChannelFlow: () => Promise<void>;
};

export function useHomeMediaActions({
    diagnosticsState,
    mediaLibrary,
    confirmDeleteChannelFlow,
}: UseHomeMediaActionsOptions): HomeMediaActionsController {
    // Destructure the stable fields off the per-render controller objects so the callbacks
    // below can depend on them directly. This keeps the dependency arrays honest (no
    // eslint-disable) while still not depending on the whole object, whose identity changes
    // every render.
    const { diagnosticsOpen, reloadDiagnostics } = diagnosticsState;
    const {
        addMedia: addMediaAction,
        confirmDeleteMedia: confirmDeleteMediaAction,
        markAsWatched: markAsWatchedAction,
        markAsUnwatched: markAsUnwatchedAction,
        watchedActionInFlight,
        editTitle,
        saveMediaProgress: saveMediaProgressAction,
    } = mediaLibrary;

    const refreshDiagnosticsIfOpen = useCallback(async (): Promise<void> => {
        if (!diagnosticsOpen) {
            return;
        }

        await reloadDiagnostics();
    }, [diagnosticsOpen, reloadDiagnostics]);

    const runActionAndRefreshDiagnostics = useCallback(
        async (action: () => Promise<void>): Promise<void> => {
            await action();
            await refreshDiagnosticsIfOpen();
        },
        [refreshDiagnosticsIfOpen]
    );

    const addMedia = useCallback(async (): Promise<void> => {
        await runActionAndRefreshDiagnostics(addMediaAction);
    }, [addMediaAction, runActionAndRefreshDiagnostics]);

    const confirmDeleteMedia = useCallback(async (): Promise<void> => {
        await runActionAndRefreshDiagnostics(confirmDeleteMediaAction);
    }, [confirmDeleteMediaAction, runActionAndRefreshDiagnostics]);

    const confirmDeleteChannel = useCallback(async (): Promise<void> => {
        await runActionAndRefreshDiagnostics(confirmDeleteChannelFlow);
    }, [confirmDeleteChannelFlow, runActionAndRefreshDiagnostics]);

    const markAsWatched = useCallback(
        async (mediaId: number): Promise<void> => {
            await runActionAndRefreshDiagnostics(() => markAsWatchedAction(mediaId));
        },
        [markAsWatchedAction, runActionAndRefreshDiagnostics]
    );

    const markAsUnwatched = useCallback(
        async (mediaId: number): Promise<void> => {
            await runActionAndRefreshDiagnostics(() => markAsUnwatchedAction(mediaId));
        },
        [markAsUnwatchedAction, runActionAndRefreshDiagnostics]
    );

    const editMediaTitle = useCallback(
        async (media: MediaRow, title: string): Promise<void> => {
            await runActionAndRefreshDiagnostics(() => editTitle(media, title));
        },
        [editTitle, runActionAndRefreshDiagnostics]
    );

    const saveMediaProgress = useCallback(
        async (mediaId: number, progressSeconds: number): Promise<void> => {
            // Playback progress does not affect anything the diagnostics dialog reports
            // (library integrity, tool status, database counts), so this deliberately skips
            // the diagnostics refresh the other actions run - otherwise the periodic saves the
            // player makes during playback would reload an open diagnostics dialog every few
            // seconds.
            await saveMediaProgressAction(mediaId, progressSeconds);
        },
        [saveMediaProgressAction]
    );

    return useMemoObject({
        addMedia,
        confirmDeleteMedia,
        confirmDeleteChannel,
        markAsWatched,
        markAsUnwatched,
        watchedActionInFlight,
        editMediaTitle,
        saveMediaProgress,
    });
}