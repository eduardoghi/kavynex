import { useMemo } from "react";
import type { HomePlayerPanelState, MediaPlayerController } from "../types/controllers";

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
    return useMemo(() => {
        return {
            media: mediaPlayer.activeMedia,
            mediaSrc: mediaPlayer.activeSrc,
            thumbnailSrc: mediaPlayer.activeThumbSrc,
            isAudio: mediaPlayer.activeIsAudio,
            canOpenInYoutube: mediaPlayer.canOpenInYoutube,
            isWatched: mediaPlayer.activeIsWatched,
        };
    }, [
        mediaPlayer.activeIsAudio,
        mediaPlayer.activeIsWatched,
        mediaPlayer.activeMedia,
        mediaPlayer.activeSrc,
        mediaPlayer.activeThumbSrc,
        mediaPlayer.canOpenInYoutube,
    ]);
}