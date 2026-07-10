import { createContext, useContext } from "react";

// Whether the player may load remote comment/live-chat images (author avatars, custom emojis
// and super-sticker images) from Google's CDNs. Defaults to true so any consumer rendered
// outside a provider keeps the historical behavior.
const RemoteImagesContext = createContext<boolean>(true);

export const RemoteImagesProvider = RemoteImagesContext.Provider;

export function useRemoteImagesEnabled(): boolean {
    return useContext(RemoteImagesContext);
}
