import type { MediaRow } from "../../types/media";
import type { MediaPlayerController } from "../media/use-media-player";
import { useMemoObject } from "../use-memo-object";

export type HomePlayerPanelState = {
    media: MediaRow | null;
    mediaSrc: string;
    thumbnailSrc: string;
    isAudio: boolean;
    canOpenInYoutube: boolean;
    isWatched: boolean;
};

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