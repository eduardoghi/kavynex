export type ImportMode = "copy" | "move";

export type AppSettings = {
    importMode: ImportMode;
    libraryPath: string;
    // When false, the player shows monogram avatars and hides custom emojis/stickers instead
    // of loading them from Google's CDNs. Defaults to false (opt-in).
    loadRemoteImages: boolean;
    // When true, the app runs one passive update check on startup and notifies if a newer
    // version is available. Defaults to false, so the app contacts the update endpoint only when
    // the user explicitly checks (or opts in here).
    checkUpdatesOnStartup: boolean;
};