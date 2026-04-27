import { getDb } from "../lib/db";
import type { AppSettings, ImportMode } from "../types/settings";

const DEFAULT_SETTINGS: AppSettings = {
    importMode: "copy",
    libraryPath: "",
};

const SETTINGS_KEYS = {
    importMode: "import_mode",
    libraryPath: "library_path",
} as const;

type AppSettingRow = {
    key: string;
    value: string;
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

function mapRowsToSettings(rows: AppSettingRow[]): AppSettings {
    const settings = cloneDefaultSettings();

    for (const row of rows) {
        if (row.key === SETTINGS_KEYS.importMode) {
            settings.importMode = normalizeImportMode(row.value);
            continue;
        }

        if (row.key === SETTINGS_KEYS.libraryPath) {
            settings.libraryPath = normalizeLibraryPath(row.value);
        }
    }

    return settings;
}

async function readSettingsRows(): Promise<AppSettingRow[]> {
    const db = await getDb();

    return db.select<AppSettingRow[]>(
        `
            SELECT key, value
            FROM app_settings
            WHERE key IN (?, ?)
        `,
        [SETTINGS_KEYS.importMode, SETTINGS_KEYS.libraryPath]
    );
}

async function upsertSetting(key: string, value: string): Promise<void> {
    const db = await getDb();

    await db.execute(
        `
            INSERT INTO app_settings (key, value, created_at, updated_at)
            VALUES (?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now')
        `,
        [key, value]
    );
}

export function getDefaultAppSettings(): AppSettings {
    return cloneDefaultSettings();
}

export async function loadStoredSettings(): Promise<AppSettings> {
    const rows = await readSettingsRows();
    return mapRowsToSettings(rows);
}

export async function persistSettings(settings: AppSettings): Promise<void> {
    await upsertSetting(SETTINGS_KEYS.importMode, settings.importMode);
    await upsertSetting(SETTINGS_KEYS.libraryPath, settings.libraryPath.trim());
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