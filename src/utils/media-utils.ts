import { convertFileSrc } from "../lib/tauri-platform";
import { AUDIO_FILE_EXTENSIONS, IMAGE_FILE_EXTENSIONS } from "../types/generated/fileExtensions";
import type { MediaType } from "../types/media";
import { fileNameFromPath, normalizePathSeparators, stripWindowsExtendedPrefix } from "./paths";

// Re-exported, since this is where the media code has always imported them from.
export { fileNameFromPath, normalizePathSeparators, stripWindowsExtendedPrefix };

// The file types the backend accepts (audio and video to import, images for a thumbnail or channel
// avatar), generated from src-tauri/src/utils/format.rs so the file pickers offer exactly that and
// the two sides cannot drift (see "Generated TypeScript bindings" in docs/ARCHITECTURE.md). The
// backend is the one that refuses a file.
export {
    AUDIO_FILE_EXTENSIONS,
    IMAGE_FILE_EXTENSIONS,
    VIDEO_FILE_EXTENSIONS,
} from "../types/generated/fileExtensions";

const AUDIO_EXTENSIONS = new Set<string>(AUDIO_FILE_EXTENSIONS);

// Accepted types the built-in player usually cannot decode. WebView2 (Chromium) has no demuxer for
// these containers, and while WebKitGTK on Linux hands playback to GStreamer and may manage some of
// them, nothing guarantees the plugins are installed. The import goes ahead either way. This only
// lets the form say so before the file is added, instead of the player saying it afterwards.
const LIKELY_UNPLAYABLE_EXTENSIONS = new Set<string>([
    "avi",
    "wmv",
    "flv",
    "mpg",
    "mpeg",
    "wma",
    "aiff",
    // MPEG transport streams (TV and camera recordings). Chromium has no demuxer for them outside
    // a streaming library, and on the desktop none for 3GP either.
    "ts",
    "m2ts",
    "3gp",
]);

// Whether the built-in player is likely to refuse this file. See LIKELY_UNPLAYABLE_EXTENSIONS.
export function mayNotPlayInBuiltInPlayer(path: string): boolean {
    const name = fileNameFromPath(path).toLowerCase();
    const dot = name.lastIndexOf(".");

    return dot !== -1 && LIKELY_UNPLAYABLE_EXTENSIONS.has(name.slice(dot + 1));
}

const THUMBNAIL_EXTENSIONS = new Set<string>(IMAGE_FILE_EXTENSIONS);

// Hoisted module-level so formatDateValue/formatCreatedAt do not rebuild an Intl.DateTimeFormat
// on every call. Construction is comparatively expensive and these formatters have no per-call
// state, so a single shared instance is safe to reuse across renders.
const MEDIUM_DATE_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const MEDIUM_DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
});

function toAssetPath(value: string): string {
    return normalizePathSeparators(stripWindowsExtendedPrefix(value));
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

// Whether a media item counts as watched. The rule lives in one place so the handful of call sites
// that need it (cards, player, progress persistence, home actions) cannot drift. A whitespace-only
// `watched_at` is treated as unwatched, since a real ISO timestamp is the only "watched" marker the
// backend writes. Accepts a structural shape so it works with both a full MediaRow and the player's
// nullable active-media value.
export function isMediaWatched(
    media: { watched_at: string | null } | null | undefined
): boolean {
    return Boolean(media?.watched_at?.trim());
}

// How close to the end a saved position has to be for the media to count as finished rather than
// as somewhere to resume. Generous on purpose. `ended` is what marks a row watched, and a position
// saved a few seconds short of it means the user stopped at the credits, not that they want to be
// dropped there.
export const RESUME_COMPLETION_TOLERANCE_SECONDS = 5;

// Where playback should start for a stored position, or null to start from the beginning.
//
// Returning null for a position at (or past) the end is what keeps a finished media from opening
// on its last second, playing for an instant and ending again, which reads as a broken file. That
// state is reachable from rows written before the player marked a finished media watched, and from
// a duration that shrank under a stored position.
export function resumePositionFor(progressSeconds: number, duration: number): number | null {
    if (progressSeconds <= 0 || !Number.isFinite(duration) || duration <= 0) {
        return null;
    }

    if (duration - progressSeconds <= RESUME_COMPLETION_TOLERANCE_SECONDS) {
        return null;
    }

    return progressSeconds;
}

export function resolveStoredPath(
    storedPath: string | null,
    libraryPath: string
): string | null {
    const normalizedStoredPath = storedPath?.trim() ?? "";

    // A row never stores a network path, since the backend writes library-relative paths and an
    // imported database is refused when it holds anything else. One reaching here anyway is not
    // turned into a URL, because loading `\\host\share\x.png` makes Windows authenticate to `host`.
    if (!normalizedStoredPath || /^[\\/]{2}/.test(normalizedStoredPath)) {
        return null;
    }

    if (/^[a-zA-Z]:[\\/]/.test(normalizedStoredPath) || normalizedStoredPath.startsWith("/")) {
        return normalizePathSeparators(normalizedStoredPath);
    }

    return joinNormalizedPath(libraryPath, normalizedStoredPath);
}

// The scheme `services/media_protocol.rs` registers. It reaches the webview as
// `kvxmedia://localhost/...` on macOS and Linux and as `http://kvxmedia.localhost/...` on Windows,
// which is why the CSP lists both spellings under `media-src`.
const MEDIA_SCHEME = "kvxmedia";

// The loopback server's origin and token (`http://127.0.0.1:<port>/<token>`) when the backend runs
// one, which it does on Linux only. WebKitGTK's media player cannot read a custom scheme, so there
// the player reads from this server instead. See `services/media_server.rs`. Set once at boot by
// `services/media-server-service.ts`.
let mediaServerOrigin: string | null = null;

export function setMediaServerOrigin(origin: string | null): void {
    mediaServerOrigin = origin;
}

/**
 * Builds the URL the player's `<video>`/`<audio>` reads from.
 *
 * Deliberately not `convertFileSrc`. That returns an `asset:` URL, and Tauri's asset protocol
 * truncates every range response to 1 MB, which the Apple media stack does not recover from once a
 * recording's metadata grows past a few megabytes. A 47 MB file fails there while a 571 MB one
 * plays, so it tracks the frame count rather than the byte size, and an archived livestream is
 * exactly the shape that trips it. See `services/media_protocol.rs` for the measurement.
 *
 * Thumbnails deliberately stay on `convertFileSrc`. They are far too small for that cap to bite, and
 * leaving them there keeps this second scheme serving only the case that needed it.
 */
export function mediaSrcFromAbsolutePath(path: string | null): string {
    const normalized = path?.trim() ?? "";

    if (!normalized) {
        return "";
    }

    // The server answers the same encoded path the scheme carries, after its token.
    if (mediaServerOrigin) {
        return `${mediaServerOrigin}/${encodeURIComponent(toAssetPath(normalized))}`;
    }

    // `convertFileSrc` with a protocol argument rather than a hand-built URL. The scheme reaches
    // the webview differently per platform (`kvxmedia://localhost/...` on macOS and Linux,
    // `http://kvxmedia.localhost/...` on Windows), and this is the function that knows which.
    // Building the string here would work on macOS and silently break on Windows.
    return convertFileSrc(toAssetPath(normalized), MEDIA_SCHEME);
}

export function fileSrcFromAbsolutePath(path: string | null): string {
    const normalized = path?.trim() ?? "";

    if (!normalized) {
        return "";
    }

    return convertFileSrc(toAssetPath(normalized));
}

/** `mediaSrcFromAbsolutePath` for a path as the database stores it (relative to the library). */
export function mediaSrcFromStoredPath(storedPath: string | null, libraryPath: string): string {
    return mediaSrcFromAbsolutePath(resolveStoredPath(storedPath, libraryPath));
}

export function fileSrcFromStoredPath(
    storedPath: string | null,
    libraryPath: string
): string {
    const absolutePath = resolveStoredPath(storedPath, libraryPath);
    return fileSrcFromAbsolutePath(absolutePath);
}

export function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
        return "";
    }

    const totalSeconds = Math.floor(seconds);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
    }

    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

// The same output as the backend's format_bytes, so two sizes side by side in Diagnostics read
// alike. shared/byte-size-cases.json is asserted against both.
export function formatBytes(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return "size unknown";
    }

    let scaled = value;
    let unit = 0;

    while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
        scaled /= 1024;
        unit += 1;
    }

    return unit === 0 ? `${value} B` : `${scaled.toFixed(2)} ${BYTE_UNITS[unit]}`;
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
        return MEDIUM_DATE_FORMAT.format(localDate);
    }

    const date = new Date(normalized);

    if (Number.isNaN(date.getTime())) {
        return normalized;
    }

    return MEDIUM_DATE_FORMAT.format(date);
}

export function formatPublishedDate(value: string | null | undefined): string {
    return formatDateValue(value);
}

// A trailing `Z` or a `+hh:mm`/`-hhmm` offset.
const EXPLICIT_TIME_ZONE = /(?:z|[+-]\d{2}:?\d{2})$/i;

// `created_at` is SQLite's `datetime('now')`, which is UTC written without a zone. JavaScript reads a
// zone-less date-time as local time, which showed every "added" time off by the user's UTC offset,
// so a value with no zone of its own is read as UTC and then shown in local time.
export function formatCreatedAt(value: string | null | undefined): string {
    const normalized = value?.trim() ?? "";

    if (!normalized) {
        return "";
    }

    const isoLike = normalized.replace(" ", "T");
    const readsAsLocal = isoLike.includes("T") && !EXPLICIT_TIME_ZONE.test(isoLike);
    const date = new Date(readsAsLocal ? `${isoLike}Z` : isoLike);

    if (Number.isNaN(date.getTime())) {
        return normalized;
    }

    return MEDIUM_DATE_TIME_FORMAT.format(date);
}
