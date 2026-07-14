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

export async function checkAppUpdate(): Promise<Update | null> {
    return await checkForAppUpdate({
        timeout: 30000
    });
}

export function toAppUpdateInfo(update: Update): AppUpdateInfo {
    return {
        currentVersion: update.currentVersion,
        version: update.version,
        date: update.date,
        body: update.body
    };
}

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
    });

    await relaunch();
}