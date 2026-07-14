import { createContext, useContext } from "react";

// Whether the player may load remote comment/live-chat images (author avatars, custom emojis
// and super-sticker images) from Google's CDNs. Defaults to false so any consumer accidentally
// rendered outside a provider fails closed (makes no network request) instead of leaking image
// loads against the user's privacy setting. The provider always supplies the real setting in the
// only place these components are used (inside MediaPlayerView).
const RemoteImagesContext = createContext<boolean>(false);

export const RemoteImagesProvider = RemoteImagesContext.Provider;

export function useRemoteImagesEnabled(): boolean {
    return useContext(RemoteImagesContext);
}
