import { useMemo } from "react";
import type { Channel, MediaRow, ViewMode } from "../types/media";
import {
    buildItemCountLabel,
    hasSelectedChannel,
} from "../utils/controller-helpers";

type UseHomeLibraryPanelOptions = {
    selectedChannel: Channel | null;
    mediaItems: MediaRow[];
    viewMode: ViewMode;
    isLoadingMedia: boolean;
    isAddingMedia?: boolean;
    isMigratingLibraryPath?: boolean;
    libraryPath?: string;
};

type HomeLibraryPanelState = {
    showSelectedChannelPanel: boolean;
    itemCountLabel: string;
    disableAddMedia: boolean;
};

export function useHomeLibraryPanel({
    selectedChannel,
    mediaItems,
    viewMode,
    isLoadingMedia,
    isAddingMedia = false,
    isMigratingLibraryPath = false,
    libraryPath = "",
}: UseHomeLibraryPanelOptions): HomeLibraryPanelState {
    return useMemo(() => {
        const showSelectedChannelPanel = hasSelectedChannel(selectedChannel);

        const disableAddMedia =
            viewMode !== "library" ||
            isLoadingMedia ||
            isAddingMedia ||
            isMigratingLibraryPath ||
            !libraryPath.trim();

        return {
            showSelectedChannelPanel,
            itemCountLabel: buildItemCountLabel(mediaItems),
            disableAddMedia,
        };
    }, [
        selectedChannel,
        mediaItems,
        viewMode,
        isLoadingMedia,
        isAddingMedia,
        isMigratingLibraryPath,
        libraryPath,
    ]);
}