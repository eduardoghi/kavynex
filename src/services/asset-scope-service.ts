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

// There used to be an `allowAssetFile` here, which authorized one user-picked image so the manual
// thumbnail preview could load it. It is gone. The scope has no way to withdraw a grant, so those
// accumulated for the whole session, and revoking one would have been worse (a forbid outranks every
// later allow, so the same image picked twice would stop rendering). The preview now draws a staged
// copy from a directory that is already authorized. See `stageManualThumbnail` in
// `services/thumbnail-service.ts`. This module is therefore down to the library grant alone.
