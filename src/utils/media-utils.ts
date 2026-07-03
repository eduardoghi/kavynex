import { convertFileSrc } from "@tauri-apps/api/core";
import type { MediaType } from "../types/media";

const AUDIO_EXTENSIONS = new Set([
    "mp3",
    "m4a",
    "aac",
    "wav",
    "flac",
    "ogg",
    "opus",
    "wma",
    "alac",
    "aiff",
]);

const THUMBNAIL_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "avif"]);

export function normalizePathSeparators(value: string): string {
    return value.replace(/\\/g, "/");
}

// Removes the Windows extended-length prefix (\\?\ or the slash-normalized //?/ form,
// including the UNC variants) so the path handed to convertFileSrc matches the asset
// protocol scope authorized on the backend. On non-Windows paths this is a no-op.
export function stripWindowsExtendedPrefix(value: string): string {
    const uncMatch = value.match(/^[\\/]{2}\?[\\/]UNC[\\/](.*)$/i);

    if (uncMatch) {
        return `\\\\${uncMatch[1]}`;
    }

    const match = value.match(/^[\\/]{2}\?[\\/](.*)$/);

    if (match) {
        return match[1];
    }

    return value;
}

function toAssetPath(value: string): string {
    return normalizePathSeparators(stripWindowsExtendedPrefix(value));
}

export function fileNameFromPath(path: string): string {
    const normalized = normalizePathSeparators(path.trim());

    if (!normalized) {
        return "";
    }

    const parts = normalized.split("/").filter(Boolean);

    return parts[parts.length - 1] ?? "";
}

export function extensionFromPath(path: string): string {
    const fileName = fileNameFromPath(path);
    const dotIndex = fileName.lastIndexOf(".");

    if (dotIndex < 0 || dotIndex === fileName.length - 1) {
        return "";
    }

    return fileName.slice(dotIndex + 1).trim().toLowerCase();
}

export function mediaTypeFromFile(path: string): MediaType {
    const ext = extensionFromPath(path);
    return AUDIO_EXTENSIONS.has(ext) ? "audio" : "video";
}

export function isThumbnailFile(path: string): boolean {
    const ext = extensionFromPath(path);
    return THUMBNAIL_EXTENSIONS.has(ext);
}

export function joinNormalizedPath(basePath: string, relativePath: string): string {
    const normalizedBase = normalizePathSeparators(basePath.trim()).replace(/\/+$/, "");
    const normalizedRelative = normalizePathSeparators(relativePath.trim()).replace(/^\/+/, "");

    if (!normalizedBase) {
        return normalizedRelative;
    }

    if (!normalizedRelative) {
        return normalizedBase;
    }

    return `${normalizedBase}/${normalizedRelative}`;
}

export function fileSrcFromPath(path: string | null): string | null {
    const normalized = path?.trim() ?? "";

    if (!normalized) {
        return null;
    }

    return convertFileSrc(toAssetPath(normalized));
}

export function initials(value: string): string {
    const parts = value
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);

    if (parts.length === 0) {
        return "?";
    }

    return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export function resolveStoredPath(
    storedPath: string | null,
    libraryPath: string
): string | null {
    const normalizedStoredPath = storedPath?.trim() ?? "";

    if (!normalizedStoredPath) {
        return null;
    }

    if (/^[a-zA-Z]:[\\/]/.test(normalizedStoredPath) || normalizedStoredPath.startsWith("/")) {
        return normalizePathSeparators(normalizedStoredPath);
    }

    return joinNormalizedPath(libraryPath, normalizedStoredPath);
}

export function fileSrcFromAbsolutePath(path: string | null): string {
    const normalized = path?.trim() ?? "";

    if (!normalized) {
        return "";
    }

    return convertFileSrc(toAssetPath(normalized));
}

export function fileSrcFromStoredPath(
    storedPath: string | null,
    libraryPath: string
): string {
    const absolutePath = resolveStoredPath(storedPath, libraryPath);
    return fileSrcFromAbsolutePath(absolutePath);
}

export function formatBytes(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return "size unknown";
    }

    if (value < 1024) {
        return `${value} B`;
    }

    const kb = 1024;
    const mb = kb * 1024;
    const gb = mb * 1024;

    if (value >= gb) {
        return `${(value / gb).toFixed(2)} GB`;
    }

    if (value >= mb) {
        return `${(value / mb).toFixed(2)} MB`;
    }

    return `${(value / kb).toFixed(2)} KB`;
}

function parseDateOnly(value: string): Date | null {
    const normalized = value.trim();

    if (!normalized) {
        return null;
    }

    const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (isoMatch) {
        const year = Number(isoMatch[1]);
        const month = Number(isoMatch[2]);
        const day = Number(isoMatch[3]);

        return new Date(year, month - 1, day);
    }

    const brMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

    if (brMatch) {
        const day = Number(brMatch[1]);
        const month = Number(brMatch[2]);
        const year = Number(brMatch[3]);

        return new Date(year, month - 1, day);
    }

    return null;
}

function formatDateValue(value: string | null | undefined): string {
    const normalized = value?.trim() ?? "";

    if (!normalized) {
        return "";
    }

    const localDate = parseDateOnly(normalized);

    if (localDate) {
        return new Intl.DateTimeFormat("pt-BR", {
            dateStyle: "medium",
        }).format(localDate);
    }

    const date = new Date(normalized);

    if (Number.isNaN(date.getTime())) {
        return normalized;
    }

    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "medium",
    }).format(date);
}

export function formatPublishedDate(value: string | null | undefined): string {
    return formatDateValue(value);
}

export function formatCreatedAt(value: string | null | undefined): string {
    const normalized = value?.trim() ?? "";

    if (!normalized) {
        return "";
    }

    const date = new Date(normalized.replace(" ", "T"));

    if (Number.isNaN(date.getTime())) {
        return normalized;
    }

    return new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

export function shortPath(value: string, maxLength = 60): string {
    const normalized = normalizePathSeparators(value.trim());

    if (!normalized) {
        return "";
    }

    if (normalized.length <= maxLength) {
        return normalized;
    }

    const fileName = fileNameFromPath(normalized);

    if (fileName.length + 4 >= maxLength) {
        return `.../${fileName}`;
    }

    const remaining = maxLength - fileName.length - 4;
    return `${normalized.slice(0, remaining)}.../${fileName}`;
}