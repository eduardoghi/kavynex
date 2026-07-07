// Pure yt-dlp format logic: labelling, preference sorting, synthesizing merged video+audio
// options, and picking a sensible default. Kept free of React/IPC so it can be unit-tested
// in isolation and reused by the format-loader hook.
import type { MediaType, YtDlpFormat } from "../types/media";

type ExtendedYtDlpFormat = YtDlpFormat & {
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

function compareAudioPreference(left: YtDlpFormat, right: YtDlpFormat): number {
    const leftExt = left.ext.trim().toLowerCase();
    const rightExt = right.ext.trim().toLowerCase();

    const leftM4aBoost = leftExt === "m4a" ? 1 : 0;
    const rightM4aBoost = rightExt === "m4a" ? 1 : 0;

    if (rightM4aBoost !== leftM4aBoost) {
        return rightM4aBoost - leftM4aBoost;
    }

    const abrDiff = getAbrScore(right) - getAbrScore(left);

    if (abrDiff !== 0) {
        return abrDiff;
    }

    const sizeDiff = getFileSizeScore(right) - getFileSizeScore(left);

    if (sizeDiff !== 0) {
        return sizeDiff;
    }

    return left.format_id.localeCompare(right.format_id, undefined, {
        numeric: true,
        sensitivity: "base",
    });
}

function compareVideoPreference(left: YtDlpFormat, right: YtDlpFormat): number {
    const resolutionDiff = getResolutionScore(right) - getResolutionScore(left);

    if (resolutionDiff !== 0) {
        return resolutionDiff;
    }

    const bitrateDiff = getTbrScore(right) - getTbrScore(left);

    if (bitrateDiff !== 0) {
        return bitrateDiff;
    }

    const sizeDiff = getFileSizeScore(right) - getFileSizeScore(left);

    if (sizeDiff !== 0) {
        return sizeDiff;
    }

    return left.format_id.localeCompare(right.format_id, undefined, {
        numeric: true,
        sensitivity: "base",
    });
}

function compareDisplayOrder(left: ExtendedYtDlpFormat, right: ExtendedYtDlpFormat): number {
    if (left.sort_rank !== right.sort_rank) {
        return left.sort_rank - right.sort_rank;
    }

    const resolutionDiff = getResolutionScore(right) - getResolutionScore(left);

    if (resolutionDiff !== 0) {
        return resolutionDiff;
    }

    const abrDiff = getAbrScore(right) - getAbrScore(left);

    if (abrDiff !== 0) {
        return abrDiff;
    }

    const bitrateDiff = getTbrScore(right) - getTbrScore(left);

    if (bitrateDiff !== 0) {
        return bitrateDiff;
    }

    const sizeDiff = getFileSizeScore(right) - getFileSizeScore(left);

    if (sizeDiff !== 0) {
        return sizeDiff;
    }

    return left.format_id.localeCompare(right.format_id, undefined, {
        numeric: true,
        sensitivity: "base",
    });
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

export function buildMergedFormats(formats: YtDlpFormat[]): YtDlpFormat[] {
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

    const mergedFormats: ExtendedYtDlpFormat[] =
        preferredAudio && preferredAudioId
            ? videoOnlyFormats.map((videoFormat) => {
                  const videoFormatId = normalizeFormatId(videoFormat.format_id);

                  return {
                      format_id: `${videoFormatId}+${preferredAudioId}`,
                      display_name: buildCompactLabel("merged", videoFormat, preferredAudioExt),
                      ext: videoFormat.ext || preferredAudio.ext || "mp4",
                      media_type: "video" as const,
                      has_video: true,
                      has_audio: true,
                      filesize_bytes:
                          (videoFormat.filesize_bytes ?? 0) +
                              (preferredAudio.filesize_bytes ?? 0) || null,
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
