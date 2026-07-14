import type { Channel, ViewMode } from "../types/media";
import {
    buildItemCountLabelFromCount,
    hasSelectedChannel,
} from "../utils/controller-helpers";
import { useMemoObject } from "./use-memo-object";

type UseHomeLibraryPanelOptions = {
    selectedChannel: Channel | null;
    channelMediaTotal: number;
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
    channelMediaTotal,
    viewMode,
    isLoadingMedia,
    isAddingMedia = false,
    isMigratingLibraryPath = false,
    libraryPath = "",
}: UseHomeLibraryPanelOptions): HomeLibraryPanelState {
    const showSelectedChannelPanel = hasSelectedChannel(selectedChannel);

    const disableAddMedia =
        viewMode !== "library" ||
        isLoadingMedia ||
        isAddingMedia ||
        isMigratingLibraryPath ||
        !libraryPath.trim();

    // All three fields below are primitives (booleans/a string) recomputed fresh every render,
    // so useMemoObject's shallow compare still keeps the returned object's identity stable
    // whenever the computed values are unchanged, exactly like the useMemo this replaced.
    return useMemoObject({
        showSelectedChannelPanel,
        itemCountLabel: buildItemCountLabelFromCount(channelMediaTotal),
        disableAddMedia,
    });
}