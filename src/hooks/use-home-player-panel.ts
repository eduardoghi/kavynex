import type { HomePlayerPanelState, MediaPlayerController } from "../types/controllers";
import { useMemoObject } from "./use-memo-object";

type UseHomePlayerPanelOptions = {
    mediaPlayer: Pick<
        MediaPlayerController,
        | "activeMedia"
        | "activeSrc"
        | "activeThumbSrc"
        | "activeIsAudio"
        | "canOpenInYoutube"
        | "activeIsWatched"
    >;
};

export function useHomePlayerPanel({
    mediaPlayer,
}: UseHomePlayerPanelOptions): HomePlayerPanelState {
    return useMemoObject({
        media: mediaPlayer.activeMedia,
        mediaSrc: mediaPlayer.activeSrc,
        thumbnailSrc: mediaPlayer.activeThumbSrc,
        isAudio: mediaPlayer.activeIsAudio,
        canOpenInYoutube: mediaPlayer.canOpenInYoutube,
        isWatched: mediaPlayer.activeIsWatched,
    });
}