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
    // Absolute path of an external directory the database is mirrored into once a day, kept
    // off-volume from the app config directory. Empty means the feature is off (the default).
    // Persisted through its own command, not the whole-row settings write.
    externalBackupDir: string;
};