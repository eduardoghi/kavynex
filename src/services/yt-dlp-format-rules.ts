// Pure yt-dlp format logic: labelling, preference sorting, synthesizing merged video+audio
// options, and picking a sensible default. Kept free of React/IPC so it can be unit-tested
// in isolation and reused by the format-loader hook.
//
// This module owns what the picker shows. It takes the backend's formats (`YtDlpFormat`) and
// returns the list the user chooses from (`YtDlpFormatOption`), which is a different list: it
// adds the merged video+audio entries YouTube does not serve as a single format, and every
// entry carries a label built here. The backend deliberately sends no label or order, because
// it cannot produce either for a row it never emitted.
//
// One value this module produces does cross back to the backend and is a shared contract with it:
// the merged `format_id` string `<video_id>+<audio_id>` (see buildMergedFormats). That `+` join is
// yt-dlp's own selector syntax, and the backend re-validates every id it receives against it -
// `is_valid_format_id` (charset, non-empty `+`-separated parts) and `resolve_format_has_video`
// (each part must resolve to a real format from the fetched metadata) in
// `src-tauri/src/services/yt_dlp_download.rs`. So a compromised/garbled selector is rejected there,
// not trusted. What has no compile-time or schema guard is the *semantics*: if yt-dlp ever changed
// how `+` merges, this construction and those two Rust checks would have to move together, and
// nothing but this note and the round-trip tests (yt-dlp-format-rules.test.ts) would flag the drift.
import type { MediaType, YtDlpFormat, YtDlpFormatOption } from "../types/media";

type ExtendedYtDlpFormat = YtDlpFormatOption & {
    sort_rank: number;
};

function normalizeFormatId(value: string | null | undefined): string {
    return value?.trim() ?? "";
}

function isDrcFormat(format: YtDlpFormat): boolean {
    return normalizeFormatId(format.format_id).toLowerCase().endsWith("-drc");
}

function getResolutionScore(format: YtDlpFormat): number {
    return Math.max(0, Number(format.height ?? 0));
}

function getFileSizeScore(format: YtDlpFormat): number {
    return Math.max(0, Number(format.filesize_bytes ?? 0));
}

function getAbrScore(format: YtDlpFormat): number {
    return Math.max(0, Number(format.abr ?? 0));
}

function getTbrScore(format: YtDlpFormat): number {
    return Math.max(0, Number(format.tbr ?? 0));
}

function formatResolution(format: YtDlpFormat): string {
    const height = getResolutionScore(format);

    if (height > 0) {
        return `${height}p`;
    }

    return "Unknown";
}

function formatExt(format: YtDlpFormat): string {
    const ext = format.ext?.trim().toUpperCase();
    return ext || "BIN";
}

function formatAbr(format: YtDlpFormat): string {
    const abr = getAbrScore(format);

    if (abr > 0) {
        const rounded = Number.isInteger(abr) ? String(abr) : abr.toFixed(1);
        return `${rounded} kbps`;
    }

    return "";
}

function formatBitrate(format: YtDlpFormat): string {
    const bitrate = getTbrScore(format);

    if (bitrate > 0) {
        const rounded = Number.isInteger(bitrate) ? String(bitrate) : bitrate.toFixed(1);
        return `${rounded} kbps`;
    }

    return "";
}

function formatCodec(format: YtDlpFormat): string {
    const codec = format.vcodec?.trim().toLowerCase() ?? "";

    if (!codec || codec === "none") {
        return "";
    }

    if (codec.startsWith("avc1")) {
        return "AVC (H.264)";
    }

    if (codec.startsWith("av01")) {
        return "AV1";
    }

    if (codec.startsWith("vp9")) {
        return "VP9";
    }

    if (codec.startsWith("hev1") || codec.startsWith("hvc1")) {
        return "HEVC (H.265)";
    }

    return format.vcodec?.trim() ?? "";
}

function formatProtocol(format: YtDlpFormat): string {
    const protocol = format.protocol?.trim().toLowerCase() || "";

    if (!protocol) {
        return "";
    }

    if (protocol === "https" || protocol === "http") {
        return "HTTPS";
    }

    if (protocol.includes("m3u8")) {
        return "M3U8";
    }

    if (protocol.includes("dash")) {
        return "DASH";
    }

    return protocol.toUpperCase();
}

function appendProtocol(label: string, format: YtDlpFormat): string {
    const protocol = formatProtocol(format);

    if (!protocol) {
        return label;
    }

    return `${label} · ${protocol}`;
}

function appendDrc(parts: string[], format: YtDlpFormat): string[] {
    if (isDrcFormat(format)) {
        parts.push("DRC");
    }

    return parts;
}

export function buildCompactLabel(
    kind: "merged" | "native" | "video_only" | "audio_only",
    format: YtDlpFormat,
    preferredAudioExt?: string
): string {
    const resolution = formatResolution(format);
    const ext = formatExt(format);
    const abrLabel = formatAbr(format);
    const bitrateLabel = formatBitrate(format);
    const codecLabel = formatCodec(format);

    if (kind === "merged") {
        const parts = ["Merged", resolution, ext];

        if (codecLabel) {
            parts.push(codecLabel);
        }

        if (bitrateLabel) {
            parts.push(bitrateLabel);
        }

        appendDrc(parts, format);

        return appendProtocol(parts.join(" · "), format);
    }

    if (kind === "native") {
        const parts = ["Native", resolution, ext];

        if (codecLabel) {
            parts.push(codecLabel);
        }

        if (bitrateLabel) {
            parts.push(bitrateLabel);
        }

        appendDrc(parts, format);

        return appendProtocol(parts.join(" · "), format);
    }

    if (kind === "video_only") {
        const parts = ["Video only", resolution, ext];

        if (codecLabel) {
            parts.push(codecLabel);
        }

        if (bitrateLabel) {
            parts.push(bitrateLabel);
        }

        appendDrc(parts, format);

        return appendProtocol(parts.join(" · "), format);
    }

    const parts = ["Audio only", preferredAudioExt || ext];

    if (abrLabel) {
        parts.push(abrLabel);
    }

    appendDrc(parts, format);

    return appendProtocol(parts.join(" · "), format);
}

// Compares two formats by a sequence of "higher is better" scores, in order, returning as soon as
// one differs (higher first). When every score ties, falls back to a natural-numeric comparison of
// the format id so the order stays deterministic. The three sorts below differ only in which scores
// they rank by, so they share this ladder instead of each repeating the compare-return-or-continue
// chain.
function compareByDescendingScores(
    left: YtDlpFormat,
    right: YtDlpFormat,
    scores: ReadonlyArray<(format: YtDlpFormat) => number>
): number {
    for (const score of scores) {
        const diff = score(right) - score(left);

        if (diff !== 0) {
            return diff;
        }
    }

    return left.format_id.localeCompare(right.format_id, undefined, {
        numeric: true,
        sensitivity: "base",
    });
}

// 1 for an m4a audio stream, 0 otherwise, so descending order floats m4a to the front - it muxes
// into an mp4 container without a re-encode, making it the preferred merge partner.
function m4aPreferenceScore(format: YtDlpFormat): number {
    return format.ext.trim().toLowerCase() === "m4a" ? 1 : 0;
}

function compareAudioPreference(left: YtDlpFormat, right: YtDlpFormat): number {
    return compareByDescendingScores(left, right, [
        m4aPreferenceScore,
        getAbrScore,
        getFileSizeScore,
    ]);
}

function compareVideoPreference(left: YtDlpFormat, right: YtDlpFormat): number {
    return compareByDescendingScores(left, right, [
        getResolutionScore,
        getTbrScore,
        getFileSizeScore,
    ]);
}

function compareDisplayOrder(left: ExtendedYtDlpFormat, right: ExtendedYtDlpFormat): number {
    // sort_rank groups the list (merged, native, video-only, audio-only) and is the only ascending
    // key - a lower rank comes first - so it is compared here rather than through the descending
    // helper, which then breaks ties within a group by the same scores the other sorts rank by.
    if (left.sort_rank !== right.sort_rank) {
        return left.sort_rank - right.sort_rank;
    }

    return compareByDescendingScores(left, right, [
        getResolutionScore,
        getAbrScore,
        getTbrScore,
        getFileSizeScore,
    ]);
}

function removeDuplicateFormats(formats: ExtendedYtDlpFormat[]): ExtendedYtDlpFormat[] {
    const seen = new Set<string>();
    const nextFormats: ExtendedYtDlpFormat[] = [];

    for (const format of formats) {
        const formatId = normalizeFormatId(format.format_id);

        if (!formatId || seen.has(formatId)) {
            continue;
        }

        seen.add(formatId);
        nextFormats.push(format);
    }

    return nextFormats;
}

export function buildMergedFormats(formats: YtDlpFormat[]): YtDlpFormatOption[] {
    const nativeFormats: ExtendedYtDlpFormat[] = formats
        .filter((item) => item.has_video && item.has_audio)
        .map((item) => ({
            ...item,
            display_name: buildCompactLabel("native", item),
            sort_rank: 1,
        }));

    const videoOnlyFormats: ExtendedYtDlpFormat[] = formats
        .filter((item) => item.has_video && !item.has_audio)
        .sort(compareVideoPreference)
        .map((item) => ({
            ...item,
            display_name: buildCompactLabel("video_only", item),
            sort_rank: 2,
        }));

    const audioOnlyFormats: ExtendedYtDlpFormat[] = formats
        .filter((item) => !item.has_video && item.has_audio)
        .sort(compareAudioPreference)
        .map((item) => ({
            ...item,
            display_name: buildCompactLabel("audio_only", item),
            sort_rank: 3,
        }));

    const preferredAudio = audioOnlyFormats[0];
    const preferredAudioId = normalizeFormatId(preferredAudio?.format_id);
    const preferredAudioExt = preferredAudio?.ext.trim().toUpperCase() || "AUDIO";

    // A merged entry's size is the sum of its two tracks, so it is only knowable when both are.
    // Treating a missing side as 0 would understate the total by that entire track.
    function mergedFilesizeBytes(
        videoBytes: number | null | undefined,
        audioBytes: number | null | undefined
    ): number | null {
        if (videoBytes == null || audioBytes == null) {
            return null;
        }

        const total = videoBytes + audioBytes;

        return total > 0 ? total : null;
    }

    const mergedFormats: ExtendedYtDlpFormat[] =
        preferredAudio && preferredAudioId
            ? videoOnlyFormats.map((videoFormat) => {
                  const videoFormatId = normalizeFormatId(videoFormat.format_id);

                  return {
                      // The `+` selector is a contract re-validated by the backend; see the
                      // module header for is_valid_format_id / resolve_format_has_video.
                      format_id: `${videoFormatId}+${preferredAudioId}`,
                      display_name: buildCompactLabel("merged", videoFormat, preferredAudioExt),
                      ext: videoFormat.ext || preferredAudio.ext || "mp4",
                      media_type: "video" as const,
                      has_video: true,
                      has_audio: true,
                      // Only report a merged size when *both* sides are known. Coalescing a
                      // missing side to 0 understates the total by that whole track, and the
                      // side that goes missing is normally the video one: yt-dlp often omits
                      // filesize on DASH video-only formats, which would render a 1080p entry
                      // as the size of its audio alone. A null reads as "size unknown", which
                      // is the truth here.
                      filesize_bytes: mergedFilesizeBytes(
                          videoFormat.filesize_bytes,
                          preferredAudio.filesize_bytes
                      ),
                      height: videoFormat.height,
                      abr: preferredAudio.abr ?? null,
                      tbr: videoFormat.tbr ?? null,
                      vcodec: videoFormat.vcodec ?? null,
                      protocol: videoFormat.protocol ?? null,
                      sort_rank: 0,
                  };
              })
            : [];

    const orderedFormats = removeDuplicateFormats([
        ...mergedFormats,
        ...nativeFormats,
        ...videoOnlyFormats,
        ...audioOnlyFormats,
    ]).sort(compareDisplayOrder);

    return orderedFormats.map(({ sort_rank: _, ...format }) => format);
}

export function inferPreferredFormatId(formats: YtDlpFormat[]): string {
    const mergedFormat = formats.find(
        (item) =>
            item.has_video && item.has_audio && normalizeFormatId(item.format_id).includes("+")
    );

    if (mergedFormat) {
        return mergedFormat.format_id;
    }

    const nativeFormat = formats.find(
        (item) =>
            item.has_video && item.has_audio && !normalizeFormatId(item.format_id).includes("+")
    );

    if (nativeFormat) {
        return nativeFormat.format_id;
    }

    return formats[0]?.format_id ?? "";
}

export function inferSelectedMediaType(formats: YtDlpFormat[], selectedFormatId: string): MediaType {
    const selected = formats.find((item) => item.format_id === selectedFormatId);

    if (selected) {
        return selected.media_type;
    }

    return formats[0]?.media_type ?? "video";
}
