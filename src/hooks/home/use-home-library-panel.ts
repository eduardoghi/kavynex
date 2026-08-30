import type { Channel, ViewMode } from "../../types/media";
import {
    buildItemCountLabelFromCount,
    hasSelectedChannel,
} from "../../utils/controller-helpers";
import { useMemoObject } from "../use-memo-object";

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
    addMediaDisabledReason: string;
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

    // Only the missing library folder gets a reason, and `disableAddMedia` above is deliberately
    // not derived from it (unlike `use-home-ui-guards`, where the reason is the source of the
    // flag). The other conditions are transient and visibly so. A page still loading, a creation
    // in flight, a migration running, the player open. A line of text under the button for each
    // would be noise, and deriving the flag from the reason would mean inventing one for all of
    // them or quietly re-enabling the button where none exists.
    //
    // The missing folder is different because nothing else on the screen says why the button is
    // dead, and the state is reachable without ever passing the empty state that explains it. A
    // library on a drive that is not connected is cleared on startup, and an imported database
    // can name a folder this machine does not have. Both leave channels with no folder behind
    // them.
    const addMediaDisabledReason = libraryPath.trim()
        ? ""
        : "Choose a library folder in Settings before adding media.";

    // All four fields below are primitives (booleans/strings) recomputed fresh every render,
    // so useMemoObject's shallow compare still keeps the returned object's identity stable
    // whenever the computed values are unchanged, exactly like the useMemo this replaced.
    return useMemoObject({
        showSelectedChannelPanel,
        itemCountLabel: buildItemCountLabelFromCount(channelMediaTotal),
        disableAddMedia,
        addMediaDisabledReason,
    });
}