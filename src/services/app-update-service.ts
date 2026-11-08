import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { installAppUpdateWithProgress, invokeCommand, invokeVoid } from "../lib/tauri-client";
import type { AppUpdateInfo } from "../types/generated/AppUpdateInfo";

export type { AppUpdateInfo };

export type AppUpdateProgress = {
    downloaded: number;
    total: number | null;
    percent: number | null;
};

// The update the last check found, kept for the rest of the session. The startup check runs from
// the Home controller and Settings has its own hook instance, so without this Settings opened at
// "idle" right under a notice saying a new version was out, and the user had to check again to
// reach the install button. The backend keeps the update itself, and installs the one its last
// check found.
let lastFoundUpdate: AppUpdateInfo | null = null;

// Told when lastFoundUpdate changes, for a Settings already mounted when the startup check lands.
const checkedUpdateListeners = new Set<() => void>();

export function subscribeToCheckedUpdate(listener: () => void): () => void {
    checkedUpdateListeners.add(listener);
    return () => {
        checkedUpdateListeners.delete(listener);
    };
}

// The backend checks the endpoint in the app's configuration, with its own timeout. Nothing about the
// request is chosen here.
export async function checkAppUpdate(): Promise<AppUpdateInfo | null> {
    const update = await invokeCommand(TAURI_COMMANDS.CHECK_FOR_APP_UPDATE);

    lastFoundUpdate = update;
    checkedUpdateListeners.forEach((listener) => listener());

    return update;
}

// The update the last check this session found, or null when none has run or none was found.
export function lastCheckedUpdate(): AppUpdateInfo | null {
    return lastFoundUpdate;
}

// Test-only. Forgets the update a previous test's check found.
export function resetLastCheckedUpdateForTests(): void {
    lastFoundUpdate = null;
}

// Downloads and installs the update the backend's last check found, then the backend relaunches
// into it. Settings stays locked while it runs, and the backend bounds the download, so one that
// stalls ends on its own.
export async function installAppUpdate(
    onProgress?: (progress: AppUpdateProgress) => void
): Promise<void> {
    await installAppUpdateWithProgress((progress) => {
        const percent = progress.finished
            ? 100
            : progress.total
              ? Math.round((progress.downloaded / progress.total) * 100)
              : null;

        onProgress?.({
            downloaded: progress.downloaded,
            total: progress.total,
            percent,
        });
    });
}

// Relaunches the app, for a database import or its undo, which are applied at the next startup, and
// from the crash screen.
export async function relaunchApp(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.RELAUNCH_APP);
}

// Closes the window without asking again, after the user confirmed closing during a run a close
// stops. The backend holds the close until then (src-tauri/src/services/app_close.rs).
export async function closeAppAnyway(): Promise<void> {
    await invokeVoid(TAURI_COMMANDS.CLOSE_APP_ANYWAY);
}
