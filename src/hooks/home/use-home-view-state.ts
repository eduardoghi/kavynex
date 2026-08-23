import type { HomeViewState } from "../../types/controllers";
import type { MediaPlayerController } from "../../types/controllers";
import type { Channel } from "../../types/media";
import { useMemoObject } from "../use-memo-object";

type UseHomeViewStateOptions = {
    selectedChannel: Channel | null;
    hasChannels: boolean;
    isLoadingChannels: boolean;
    isPreparingSettings: boolean;
    mediaPlayer: Pick<MediaPlayerController, "viewMode">;
    libraryPath?: string;
};

export function useHomeViewState({
    selectedChannel,
    hasChannels,
    isLoadingChannels,
    isPreparingSettings,
    mediaPlayer,
    libraryPath = "",
}: UseHomeViewStateOptions): HomeViewState {
    // Color-scheme-aware via the CSS `light-dark()` function: the first value applies in the light
    // scheme, the second in dark. Mantine sets `color-scheme` on the root when the theme toggles, so
    // these resolve automatically wherever they are used as inline style values. The light values are
    // a deliberate light palette (a soft off-white page with raised white surfaces), not a mechanical
    // inversion of the dark overlays.
    const shellSurface = "light-dark(#ffffff, rgba(255,255,255,0.035))";
    // Firmer than it was in light. At 0.09 on a near-white page a card had almost no edge,
    // so its shadow was doing the whole job of separating it from the canvas.
    const shellBorder = "light-dark(rgba(26,24,37,0.14), rgba(255,255,255,0.085))";
    // A step greyer and cooler. Against white surfaces the old value left page and card
    // reading as one plane, which is what pushed the shadows to compensate.
    const pageBackground = "light-dark(#E9E8EF, #0C0A10)";

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

    // Independent of whether channels exist: a fresh install has neither, and a channel can be
    // created before the folder is picked, so the card has to stand next to the empty state as
    // well as above a channel's library. Gated on the settings having loaded, because until then
    // an empty path means "not read yet" rather than "not set".
    const showLibrarySetup = !isPreparingSettings && showLibrary && libraryPath.trim() === "";

    // All fields below are primitive strings/booleans recomputed fresh every render, so
    // useMemoObject's shallow compare still keeps the returned object's identity stable
    // whenever the computed values are unchanged, exactly like the useMemo this replaced.
    return useMemoObject({
        shellSurface,
        shellBorder,
        pageBackground,
        showLoading,
        showEmpty,
        showSelectChannelPrompt,
        showLibrarySetup,
        showLibrary,
        showPlayer,
    });
}