import type { AppSettings, ImportMode } from "../../types/settings";
import {
    getStoredAppSettings,
    setExternalBackupDir,
    setStoredAppSettings,
} from "../../services/app-settings-command-service";

const DEFAULT_SETTINGS: AppSettings = {
    importMode: "copy",
    libraryPath: "",
    loadRemoteImages: false,
    checkUpdatesOnStartup: true,
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

// Remote images are opt-in. Only an explicit "true" enables them. An absent key (older
// databases that predate the setting, or a fresh install) or any other value keeps them off,
// so opening comments/live chat makes no network request to Google's CDNs until the user turns
// it on in Settings > Privacy.
function normalizeLoadRemoteImages(value: string | null | undefined): boolean {
    return value === "true";
}

// The startup update check is the one opt-*out* setting here, and the asymmetry with
// `loadRemoteImages` right above is deliberate rather than an oversight.
//
// Only the latest release gets fixes (SECURITY.md), and the in-app updater is how one reaches a
// user. While this was opt-in, a user who installed once and never opened Settings stayed on a
// vulnerable version indefinitely with nothing telling them so, which made the security policy
// promise a delivery path the default configuration did not provide.
//
// What it enables is a *check* that shows a notice, never an install. `installAppUpdate` stays a
// separate action the user starts from Settings, so nothing is downloaded or applied on its own.
// The cost is one unauthenticated request to the GitHub releases endpoint per launch, against an
// app that already reaches YouTube throughout normal use.
//
// An explicit "false" is the only thing that turns it off, so a user who opts out keeps that
// decision. An absent key (an older database, a fresh install) reads as on, which means flipping
// this default also turned it on for existing installs that never touched the toggle. That was the
// intent rather than a side effect of the rewrite. See docs/PRIVACY.md.
function normalizeCheckUpdatesOnStartup(value: string | null | undefined): boolean {
    return value !== "false";
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
// `app_settings` is written as a whole row. Each setter loads all four values, replaces one, and
// writes them all back. Run two of those concurrently and both read the same pre-change snapshot,
// so the second write reverts the first one's field. That is not theoretical. The Privacy and
// Application-update toggles live in the same modal, a double-click apart, and the callers are
// fire-and-forget (nothing awaits them, so nothing else orders the writes). One of the fields at
// risk is `loadRemoteImages`, which decides whether the player talks to Google's CDNs at all.
//
// Chaining is enough because these run in one webview against a single-writer database; the point
// is only that each update reads what the previous one wrote.
let settingsUpdateQueue: Promise<unknown> = Promise.resolve();

function enqueueSettingsUpdate(operation: () => Promise<AppSettings>): Promise<AppSettings> {
    // Run the next update whether the previous one resolved or rejected. A failed write must not
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

// The external backup directory has its own backend command (not the whole-row write persistSettings
// does), so this does not go through updateStoredField. It calls the dedicated command and merges the
// new value into the current settings. Still enqueued so it stays ordered with the other updates and
// the returned settings reflect a consistent snapshot. An empty string turns the feature off.
export function updateStoredExternalBackupDir(externalBackupDir: string): Promise<AppSettings> {
    return enqueueSettingsUpdate(async () => {
        const current = await loadStoredSettings();
        const normalized = normalizeExternalBackupDir(externalBackupDir);

        await setExternalBackupDir(normalized);

        return { ...current, externalBackupDir: normalized };
    });
}
