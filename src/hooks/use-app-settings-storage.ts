import type { AppSettings, ImportMode } from "../types/settings";
import {
    getStoredAppSettings,
    setStoredAppSettings,
} from "../services/app-settings-command-service";

const DEFAULT_SETTINGS: AppSettings = {
    importMode: "copy",
    libraryPath: "",
};

function cloneDefaultSettings(): AppSettings {
    return {
        importMode: DEFAULT_SETTINGS.importMode,
        libraryPath: DEFAULT_SETTINGS.libraryPath,
    };
}

function normalizeImportMode(value: string | null | undefined): ImportMode {
    return value === "move" ? "move" : "copy";
}

function normalizeLibraryPath(value: string | null | undefined): string {
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
    };
}

export async function persistSettings(settings: AppSettings): Promise<void> {
    await setStoredAppSettings(settings.importMode, settings.libraryPath.trim());
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
