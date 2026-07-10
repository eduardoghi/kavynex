export type ImportMode = "copy" | "move";

export type AppSettings = {
    importMode: ImportMode;
    libraryPath: string;
    // When false, the player shows monogram avatars and hides custom emojis/stickers instead
    // of loading them from Google's CDNs. Defaults to true.
    loadRemoteImages: boolean;
};