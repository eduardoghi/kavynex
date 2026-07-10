import { useMemo } from "react";
import type { HomeViewState } from "../types/controllers";
import type { MediaPlayerController } from "../types/controllers";
import type { Channel } from "../types/media";

type UseHomeViewStateOptions = {
    selectedChannel: Channel | null;
    hasChannels: boolean;
    isLoadingChannels: boolean;
    isPreparingSettings: boolean;
    mediaPlayer: Pick<MediaPlayerController, "viewMode">;
};

export function useHomeViewState({
    selectedChannel,
    hasChannels,
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

        const isLibraryReady =
            !isLoadingChannels &&
            !isPreparingSettings &&
            mediaPlayer.viewMode === "library";

        // Only the true "no channels at all" case is onboarding; a selected-channel-less
        // state with channels already created gets the neutral prompt below instead.
        const showEmpty = !hasChannels && isLibraryReady;

        const showSelectChannelPrompt =
            hasChannels && !selectedChannel && isLibraryReady;

        const showLibrary = mediaPlayer.viewMode === "library";
        const showPlayer = mediaPlayer.viewMode === "player";

        return {
            shellSurface,
            shellBorder,
            pageBackground,
            showLoading,
            showEmpty,
            showSelectChannelPrompt,
            showLibrary,
            showPlayer,
        };
    }, [
        hasChannels,
        isLoadingChannels,
        isPreparingSettings,
        mediaPlayer.viewMode,
        selectedChannel,
    ]);
}