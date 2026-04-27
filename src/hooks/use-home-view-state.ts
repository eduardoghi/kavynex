import { useMemo } from "react";
import type { HomeViewState } from "../types/controllers";
import type { MediaPlayerController } from "../types/controllers";
import type { Channel } from "../types/media";

type UseHomeViewStateOptions = {
    selectedChannel: Channel | null;
    isLoadingChannels: boolean;
    isPreparingSettings: boolean;
    mediaPlayer: Pick<MediaPlayerController, "viewMode">;
};

export function useHomeViewState({
    selectedChannel,
    isLoadingChannels,
    isPreparingSettings,
    mediaPlayer,
}: UseHomeViewStateOptions): HomeViewState {
    return useMemo(() => {
        const shellSurface = "rgba(255,255,255,0.035)";
        const shellBorder = "rgba(255,255,255,0.085)";
        const pageBackground = "#070A12";

        const showLoading =
            (!selectedChannel && isLoadingChannels) || isPreparingSettings;

        const showEmpty =
            !selectedChannel &&
            !isLoadingChannels &&
            !isPreparingSettings &&
            mediaPlayer.viewMode === "library";

        const showLibrary = mediaPlayer.viewMode === "library";
        const showPlayer = mediaPlayer.viewMode === "player";

        return {
            shellSurface,
            shellBorder,
            pageBackground,
            showLoading,
            showEmpty,
            showLibrary,
            showPlayer,
        };
    }, [
        isLoadingChannels,
        isPreparingSettings,
        mediaPlayer.viewMode,
        selectedChannel,
    ]);
}