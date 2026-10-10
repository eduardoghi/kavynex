import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import type { FileDialogFilter } from "../types/generated/FileDialogFilter";
import type { FolderPurpose } from "../types/generated/FolderPurpose";

export type { FileDialogFilter, FolderPurpose };

// The native pickers, opened by the backend (commands/dialog.rs). They used to come from the dialog
// plugin straight from the renderer, and the plugin adds whatever the user picks to the asset
// protocol's scope for the rest of the session, a library folder's whole root included. Going
// through the backend keeps the scope to what commands/security.rs grants, and leaves the renderer
// with no dialog permission of its own.
//
// Each resolves to the chosen path trimmed, or null when the dialog was cancelled.

function normalizePicked(picked: string | null): string | null {
    const trimmed = picked?.trim() ?? "";
    return trimmed || null;
}

// The backend titles the dialog after the purpose and accepts the folder afterwards for that
// purpose only (services/chosen_folders.rs).
export async function pickFolder(purpose: FolderPurpose): Promise<string | null> {
    return normalizePicked(await invokeCommand(TAURI_COMMANDS.OPEN_FOLDER_DIALOG, { purpose }));
}

export async function pickFile(
    options: { title?: string; filters?: FileDialogFilter[] } = {}
): Promise<string | null> {
    return normalizePicked(
        await invokeCommand(TAURI_COMMANDS.OPEN_FILE_DIALOG, {
            title: options.title ?? null,
            filters: options.filters ?? [],
        })
    );
}

export async function pickSaveDestination(
    options: { title?: string; defaultFileName?: string; filters?: FileDialogFilter[] } = {}
): Promise<string | null> {
    return normalizePicked(
        await invokeCommand(TAURI_COMMANDS.SAVE_FILE_DIALOG, {
            title: options.title ?? null,
            defaultFileName: options.defaultFileName ?? null,
            filters: options.filters ?? [],
        })
    );
}
