import { checkForAppUpdate, relaunch, type Update } from "../lib/tauri-platform";

export type AppUpdateInfo = {
    currentVersion: string;
    version: string;
    date?: string;
    body?: string;
};

export type AppUpdateProgress = {
    downloaded: number;
    total: number | null;
    percent: number | null;
};

// The update the last check found, kept for the rest of the session. The startup check runs from
// the Home controller and Settings has its own hook instance, so without this Settings opened at
// "idle" right under a notice saying a new version was out, and the user had to check again to
// reach the install button.
let lastFoundUpdate: Update | null = null;

// Told when lastFoundUpdate changes, for a Settings already mounted when the startup check lands.
const checkedUpdateListeners = new Set<() => void>();

export function subscribeToCheckedUpdate(listener: () => void): () => void {
    checkedUpdateListeners.add(listener);
    return () => {
        checkedUpdateListeners.delete(listener);
    };
}

export async function checkAppUpdate(): Promise<Update | null> {
    const update = await checkForAppUpdate({
        timeout: 30000
    });

    lastFoundUpdate = update;
    checkedUpdateListeners.forEach((listener) => listener());

    return update;
}

// The update the last check this session found, or null when none has run or none was found.
export function lastCheckedUpdate(): Update | null {
    return lastFoundUpdate;
}

// Test-only. Forgets the update a previous test's check found.
export function resetLastCheckedUpdateForTests(): void {
    lastFoundUpdate = null;
}

export function toAppUpdateInfo(update: Update): AppUpdateInfo {
    return {
        currentVersion: update.currentVersion,
        version: update.version,
        date: update.date,
        body: update.body
    };
}

// Settings stays locked while the download runs, so a download that stalls has to end on its own or
// the window cannot be closed short of quitting. Generous for an installer of a few tens of megabytes
// on a slow link.
const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export async function installAppUpdate(
    update: Update,
    onProgress?: (progress: AppUpdateProgress) => void
): Promise<void> {
    let downloaded = 0;
    let total: number | null = null;

    await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
            total = event.data.contentLength ?? null;
            downloaded = 0;

            onProgress?.({
                downloaded,
                total,
                percent: null
            });

            return;
        }

        if (event.event === "Progress") {
            downloaded += event.data.chunkLength;

            onProgress?.({
                downloaded,
                total,
                percent: total ? Math.round((downloaded / total) * 100) : null
            });

            return;
        }

        if (event.event === "Finished") {
            onProgress?.({
                downloaded,
                total,
                percent: 100
            });
        }
    }, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });

    await relaunch();
}