import { convertFileSrc } from "@tauri-apps/api/core";
import type { MediaType } from "../types/media";

function sanitizeWindowsDevicePath(path: string): string {
    if (path.startsWith("\\\\?\\")) {
        return path.slice(4);
    }

    return path;
}

function normalizePathSeparators(path: string): string {
    return path.replace(/\//g, "\\");
}

function isAbsoluteWindowsPath(path: string): boolean {
    return /^[a-zA-Z]:\\/.test(path) || path.startsWith("\\\\");
}

function isAbsoluteUnixPath(path: string): boolean {
    return path.startsWith("/");
}

function isAbsolutePath(path: string): boolean {
    return isAbsoluteWindowsPath(path) || isAbsoluteUnixPath(path);
}

function joinLibraryAndStoredPath(libraryPath: string, storedPath: string): string {
    const normalizedLibraryPath = sanitizeWindowsDevicePath(libraryPath.trim()).replace(/[\\/]+$/, "");
    const normalizedStoredPath = sanitizeWindowsDevicePath(storedPath.trim()).replace(/^[\\/]+/, "");

    if (!normalizedLibraryPath) {
        return normalizedStoredPath;
    }

    if (!normalizedStoredPath) {
        return normalizedLibraryPath;
    }

    if (normalizedLibraryPath.includes("\\")) {
        return `${normalizedLibraryPath}\\${normalizePathSeparators(normalizedStoredPath)}`;
    }

    return `${normalizedLibraryPath}/${normalizedStoredPath.replace(/\\/g, "/")}`;
}

function resolveAbsoluteMediaPath(libraryPath: string, filePath: string): string {
    const normalizedFilePath = sanitizeWindowsDevicePath(filePath.trim());

    if (isAbsolutePath(normalizedFilePath)) {
        return normalizedFilePath;
    }

    return joinLibraryAndStoredPath(libraryPath, normalizedFilePath);
}

function createMediaElement(mediaType: MediaType): HTMLMediaElement {
    if (mediaType === "audio") {
        return document.createElement("audio");
    }

    return document.createElement("video");
}

export async function readMediaDurationInSeconds(
    filePath: string,
    libraryPath: string,
    mediaType: MediaType
): Promise<number | null> {
    const normalizedFilePath = filePath.trim();
    const normalizedLibraryPath = libraryPath.trim();

    if (!normalizedFilePath || !normalizedLibraryPath) {
        return null;
    }

    const absolutePath = resolveAbsoluteMediaPath(normalizedLibraryPath, normalizedFilePath);
    const fileSrc = convertFileSrc(absolutePath);

    return new Promise<number | null>((resolve) => {
        const media = createMediaElement(mediaType);
        let settled = false;

        const cleanup = (): void => {
            media.onloadedmetadata = null;
            media.onerror = null;
            media.removeAttribute("src");
            media.load();
        };

        const finish = (value: number | null): void => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve(value);
        };

        media.preload = "metadata";

        media.onloadedmetadata = () => {
            if (!Number.isFinite(media.duration) || media.duration <= 0) {
                finish(null);
                return;
            }

            finish(Math.floor(media.duration));
        };

        media.onerror = () => {
            finish(null);
        };

        media.src = fileSrc;
    });
}