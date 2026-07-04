import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeVoid } from "../lib/tauri-client";

/**
 * Authorizes the asset protocol to read files inside the library directory.
 *
 * The asset protocol scope is restricted (no longer "**\/*"), so the webview can only
 * load media/thumbnails from directories explicitly authorized at runtime. This must be
 * called on startup once the stored library path is known, and again whenever the
 * library path changes, because the scope is in-memory and resets on restart.
 *
 * The backend rejects any path that does not match the library path persisted in the
 * settings, so this cannot be used to authorize an arbitrary directory.
 */
export async function registerLibraryAssetScope(libraryPath: string): Promise<void> {
    const normalized = libraryPath.trim();

    if (!normalized) {
        return;
    }

    await invokeVoid(TAURI_COMMANDS.REGISTER_LIBRARY_ASSET_SCOPE, {
        libraryPath: normalized,
    });
}

/**
 * Authorizes the asset protocol to read a single user-selected file, used to preview a
 * manually chosen thumbnail before it is imported into the library.
 */
export async function allowAssetFile(path: string): Promise<void> {
    const normalized = path.trim();

    if (!normalized) {
        return;
    }

    await invokeVoid(TAURI_COMMANDS.ALLOW_ASSET_FILE, {
        path: normalized,
    });
}
