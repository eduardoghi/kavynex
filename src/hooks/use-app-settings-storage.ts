import type { AppSettings, ImportMode } from "../types/settings";
import {
    getStoredAppSettings,
    setStoredAppSettings,
} from "../services/app-settings-command-service";

const DEFAULT_SETTINGS: AppSettings = {
    importMode: "copy",
    libraryPath: "",
    loadRemoteImages: false,
    checkUpdatesOnStartup: false,
    externalBackupDir: "",
};

function cloneDefaultSettings(): AppSettings {
    return {
        importMode: DEFAULT_SETTINGS.importMode,
        libraryPath: DEFAULT_SETTINGS.libraryPath,
        loadRemoteImages: DEFAULT_SETTINGS.loadRemoteImages,
        checkUpdatesOnStartup: DEFAULT_SETTINGS.checkUpdatesOnStartup,
        externalBackupDir: DEFAULT_SETTINGS.externalBackupDir,
    };
}

function normalizeImportMode(value: string | null | undefined): ImportMode {
    return value === "move" ? "move" : "copy";
}

function normalizeLibraryPath(value: string | null | undefined): string {
    return typeof value === "string" ? value.trim() : "";
}

// Remote images are opt-in: only an explicit "true" enables them. An absent key (older
// databases that predate the setting, or a fresh install) or any other value keeps them off,
// so opening comments/live chat makes no network request to Google's CDNs until the user turns
// it on in Settings > Privacy.
function normalizeLoadRemoteImages(value: string | null | undefined): boolean {
    return value === "true";
}

// The startup update check is opt-in too: only an explicit "true" enables it, so the app
// contacts the update endpoint on startup only after the user turns it on in Settings.
function normalizeCheckUpdatesOnStartup(value: string | null | undefined): boolean {
    return value === "true";
}

// An absent key (older databases, a fresh install) or a blank value means the external backup is
// off; a stored path is trimmed the same way the library path is.
function normalizeExternalBackupDir(value: string | null | undefined): string {
    return typeof value === "string" ? value.trim() : "";
}

export function getDefaultAppSettings(): AppSettings {
    return cloneDefaultSettings();
}

export async function loadStoredSettings(): Promise<AppSettings> {
    const stored = await getStoredAppSettings();

    return {
        importMode: normalizeImportMode(stored.importMode),
        libraryPath: normalizeLibraryPath(stored.libraryPath),
        loadRemoteImages: normalizeLoadRemoteImages(stored.loadRemoteImages),
        checkUpdatesOnStartup: normalizeCheckUpdatesOnStartup(stored.checkUpdatesOnStartup),
        externalBackupDir: normalizeExternalBackupDir(stored.externalBackupDir),
    };
}

export async function persistSettings(settings: AppSettings): Promise<void> {
    await setStoredAppSettings(
        settings.importMode,
        settings.libraryPath.trim(),
        settings.loadRemoteImages,
        settings.checkUpdatesOnStartup
    );
}

// Serializes the read-modify-write updates below.
//
// `app_settings` is written as a whole row: each setter loads all four values, replaces one, and
// writes them all back. Run two of those concurrently and both read the same pre-change snapshot,
// so the second write reverts the first one's field. That is not theoretical - the Privacy and
// Application-update toggles live in the same modal, a double-click apart, and the callers are
// fire-and-forget (nothing awaits them, so nothing else orders the writes). One of the fields at
// risk is `loadRemoteImages`, which decides whether the player talks to Google's CDNs at all.
//
// Chaining is enough because these run in one webview against a single-writer database; the point
// is only that each update reads what the previous one wrote.
let settingsUpdateQueue: Promise<unknown> = Promise.resolve();

function enqueueSettingsUpdate(operation: () => Promise<AppSettings>): Promise<AppSettings> {
    // Run the next update whether the previous one resolved or rejected: a failed write must not
    // wedge every later setting change for the rest of the session.
    const result = settingsUpdateQueue.then(operation, operation);

    settingsUpdateQueue = result.catch(() => undefined);

    return result;
}

async function updateStoredField(
    apply: (current: AppSettings) => AppSettings
): Promise<AppSettings> {
    const current = await loadStoredSettings();
    const next = apply(current);

    await persistSettings(next);

    return next;
}

export function updateStoredImportMode(mode: ImportMode): Promise<AppSettings> {
    return enqueueSettingsUpdate(() =>
        updateStoredField((current) => ({ ...current, importMode: normalizeImportMode(mode) }))
    );
}

export function updateStoredLibraryPath(libraryPath: string): Promise<AppSettings> {
    return enqueueSettingsUpdate(() =>
        updateStoredField((current) => ({
            ...current,
            libraryPath: normalizeLibraryPath(libraryPath),
        }))
    );
}

export function updateStoredLoadRemoteImages(loadRemoteImages: boolean): Promise<AppSettings> {
    return enqueueSettingsUpdate(() =>
        updateStoredField((current) => ({ ...current, loadRemoteImages }))
    );
}

export function updateStoredCheckUpdatesOnStartup(
    checkUpdatesOnStartup: boolean
): Promise<AppSettings> {
    return enqueueSettingsUpdate(() =>
        updateStoredField((current) => ({ ...current, checkUpdatesOnStartup }))
    );
}
