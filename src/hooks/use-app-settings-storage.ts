import type { AppSettings, ImportMode } from "../types/settings";
import {
    getStoredAppSettings,
    setStoredAppSettings,
} from "../services/app-settings-command-service";

const DEFAULT_SETTINGS: AppSettings = {
    importMode: "copy",
    libraryPath: "",
    loadRemoteImages: false,
};

function cloneDefaultSettings(): AppSettings {
    return {
        importMode: DEFAULT_SETTINGS.importMode,
        libraryPath: DEFAULT_SETTINGS.libraryPath,
        loadRemoteImages: DEFAULT_SETTINGS.loadRemoteImages,
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

export function getDefaultAppSettings(): AppSettings {
    return cloneDefaultSettings();
}

export async function loadStoredSettings(): Promise<AppSettings> {
    const stored = await getStoredAppSettings();

    return {
        importMode: normalizeImportMode(stored.importMode),
        libraryPath: normalizeLibraryPath(stored.libraryPath),
        loadRemoteImages: normalizeLoadRemoteImages(stored.loadRemoteImages),
    };
}

export async function persistSettings(settings: AppSettings): Promise<void> {
    await setStoredAppSettings(
        settings.importMode,
        settings.libraryPath.trim(),
        settings.loadRemoteImages
    );
}

export async function updateStoredImportMode(mode: ImportMode): Promise<AppSettings> {
    const current = await loadStoredSettings();

    const next: AppSettings = {
        ...current,
        importMode: normalizeImportMode(mode),
    };

    await persistSettings(next);
    return next;
}

export async function updateStoredLibraryPath(libraryPath: string): Promise<AppSettings> {
    const current = await loadStoredSettings();

    const next: AppSettings = {
        ...current,
        libraryPath: normalizeLibraryPath(libraryPath),
    };

    await persistSettings(next);
    return next;
}

export async function updateStoredLoadRemoteImages(
    loadRemoteImages: boolean
): Promise<AppSettings> {
    const current = await loadStoredSettings();

    const next: AppSettings = {
        ...current,
        loadRemoteImages,
    };

    await persistSettings(next);
    return next;
}
