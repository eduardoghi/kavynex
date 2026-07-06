import { useCallback, useMemo, useRef, useState } from "react";
import { listYtDlpFormats } from "../services/media-download-service";
import type { MediaType, YtDlpFormat } from "../types/media";
import { resolveErrorMessage } from "../utils/error-message";

type UseYtDlpFormatLoaderOptions = {
    getUrl: () => string;
    getCurrentTitle: () => string;
    getCookiesBrowser?: () => string;
    getCookiesPath?: () => string;
    onSuggestedTitle: (value: string) => void;
    onMediaTypeResolved: (value: MediaType) => void;
    onTerminalStart?: (runId: string, header: string) => void;
    onTerminalLog?: (line: string) => void;
    onTerminalStop?: () => void;
};

type UseYtDlpFormatLoaderReturn = {
    ytDlpFormats: YtDlpFormat[];
    selectedYtDlpFormatId: string;
    isLoadingYtDlpFormats: boolean;
    selectedYtDlpMediaType: MediaType;
    setSelectedYtDlpFormatId: (value: string) => void;
    resetYtDlpFormats: () => void;
    loadYtDlpFormats: () => Promise<void>;
};

const FORMAT_LOADER_RUN_ID = "format-loader";

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

function buildCompactLabel(
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

function buildMergedFormats(formats: YtDlpFormat[]): YtDlpFormat[] {
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

function inferPreferredFormatId(formats: YtDlpFormat[]): string {
    const mergedFormat = formats.find(
        (item) =>
            item.has_video &&
            item.has_audio &&
            normalizeFormatId(item.format_id).includes("+")
    );

    if (mergedFormat) {
        return mergedFormat.format_id;
    }

    const nativeFormat = formats.find(
        (item) =>
            item.has_video &&
            item.has_audio &&
            !normalizeFormatId(item.format_id).includes("+")
    );

    if (nativeFormat) {
        return nativeFormat.format_id;
    }

    return formats[0]?.format_id ?? "";
}

function inferSelectedMediaType(formats: YtDlpFormat[], selectedFormatId: string): MediaType {
    const selected = formats.find((item) => item.format_id === selectedFormatId);

    if (selected) {
        return selected.media_type;
    }

    return formats[0]?.media_type ?? "video";
}

export function useYtDlpFormatLoader({
    getUrl,
    getCurrentTitle,
    getCookiesBrowser,
    getCookiesPath,
    onSuggestedTitle,
    onMediaTypeResolved,
    onTerminalStart,
    onTerminalLog,
    onTerminalStop,
}: UseYtDlpFormatLoaderOptions): UseYtDlpFormatLoaderReturn {
    const [ytDlpFormats, setYtDlpFormats] = useState<YtDlpFormat[]>([]);
    const [selectedYtDlpFormatId, setSelectedYtDlpFormatIdState] = useState("");
    const [isLoadingYtDlpFormats, setIsLoadingYtDlpFormats] = useState(false);

    // Guards against a stale format response overwriting state after the URL changed (or was
    // reset) while yt-dlp was running - otherwise the formats/selection for an old URL could
    // repopulate over the current one, and that selection feeds the real download command.
    const latestRequestIdRef = useRef(0);

    const selectedYtDlpMediaType = useMemo<MediaType>(() => {
        return inferSelectedMediaType(ytDlpFormats, selectedYtDlpFormatId);
    }, [selectedYtDlpFormatId, ytDlpFormats]);

    const resetYtDlpFormats = useCallback((): void => {
        // Invalidate any in-flight load so its response cannot repopulate the cleared state.
        latestRequestIdRef.current += 1;
        setYtDlpFormats([]);
        setSelectedYtDlpFormatIdState("");
        onMediaTypeResolved("video");
    }, [onMediaTypeResolved]);

    const setSelectedYtDlpFormatId = useCallback(
        (value: string): void => {
            const nextSelectedFormatId = value.trim();

            setSelectedYtDlpFormatIdState(nextSelectedFormatId);

            if (!nextSelectedFormatId) {
                onMediaTypeResolved("video");
                return;
            }

            onMediaTypeResolved(inferSelectedMediaType(ytDlpFormats, nextSelectedFormatId));
        },
        [onMediaTypeResolved, ytDlpFormats]
    );

    const loadYtDlpFormats = useCallback(async (): Promise<void> => {
        const url = getUrl().trim();
        const cookiesBrowser = getCookiesBrowser?.().trim() || "";
        const cookiesPath = getCookiesPath?.().trim() || "";

        if (!url) {
            resetYtDlpFormats();
            return;
        }

        if (isLoadingYtDlpFormats) {
            return;
        }

        const requestId = ++latestRequestIdRef.current;

        setIsLoadingYtDlpFormats(true);

        const commandParts = [
            "yt-dlp",
            "-v",
            "--ignore-config",
            "--no-playlist",
            "--dump-single-json",
            "--no-warnings",
        ];

        if (cookiesPath) {
            // The cookies file path can reveal the local username/profile layout, and this
            // preview is shown in the terminal and may be pasted into a bug report. Redact
            // the value, mirroring the backend's redacted_args_for_log. The real path is
            // still passed to listYtDlpFormats below.
            commandParts.push("--cookies", "<redacted>");
        } else if (cookiesBrowser) {
            commandParts.push("--cookies-from-browser", cookiesBrowser);
        }

        commandParts.push(url);

        onTerminalStart?.(FORMAT_LOADER_RUN_ID, commandParts.join(" "));
        onTerminalLog?.("Loading formats...");

        try {
            const result = await listYtDlpFormats(
                url,
                cookiesBrowser || null,
                cookiesPath || null
            );

            // A newer request (or a reset from a URL change) superseded this one; discard the
            // stale response instead of overwriting the current formats/selection.
            if (requestId !== latestRequestIdRef.current) {
                return;
            }

            for (const line of result.terminal_logs ?? []) {
                onTerminalLog?.(line);
            }

            const rawFormats = result.formats ?? [];
            const nextFormats = buildMergedFormats(rawFormats);
            const nextSelectedFormatId = inferPreferredFormatId(nextFormats);
            const nextMediaType = inferSelectedMediaType(nextFormats, nextSelectedFormatId);

            setYtDlpFormats(nextFormats);
            setSelectedYtDlpFormatIdState(nextSelectedFormatId);
            onMediaTypeResolved(nextMediaType);

            const currentTitle = getCurrentTitle().trim();
            const suggestedTitle = result.suggested_title?.trim() ?? "";

            if (!currentTitle && suggestedTitle) {
                onSuggestedTitle(suggestedTitle);
            }

            onTerminalLog?.(`Formats loaded successfully: ${nextFormats.length}`);

            if (rawFormats.some((item) => item.has_video && !item.has_audio)) {
                onTerminalLog?.("Merged video + audio options were generated automatically.");
            }

            if (nextSelectedFormatId) {
                onTerminalLog?.(`Selected default format: ${nextSelectedFormatId}`);
            } else {
                onTerminalLog?.("No compatible formats were returned.");
            }
        } catch (error) {
            // A stale request's failure must not clear the current state or surface an error
            // for a URL the user already moved away from.
            if (requestId !== latestRequestIdRef.current) {
                return;
            }

            setYtDlpFormats([]);
            setSelectedYtDlpFormatIdState("");
            onMediaTypeResolved("video");

            let message = resolveErrorMessage(
                error,
                "Failed to load yt-dlp formats."
            );

            if (
                typeof error === "object" &&
                error !== null &&
                "details" in error &&
                typeof (error as { details?: unknown }).details === "string" &&
                (error as { details?: string }).details?.trim()
            ) {
                message = `${message}\n${(error as { details: string }).details.trim()}`;
            }

            onTerminalLog?.(`ERROR: ${message}`);
            throw error;
        } finally {
            setIsLoadingYtDlpFormats(false);
            onTerminalStop?.();
        }
    }, [
        getCookiesBrowser,
        getCookiesPath,
        getCurrentTitle,
        getUrl,
        isLoadingYtDlpFormats,
        onMediaTypeResolved,
        onSuggestedTitle,
        onTerminalLog,
        onTerminalStart,
        onTerminalStop,
        resetYtDlpFormats,
    ]);

    return {
        ytDlpFormats,
        selectedYtDlpFormatId,
        isLoadingYtDlpFormats,
        selectedYtDlpMediaType,
        setSelectedYtDlpFormatId,
        resetYtDlpFormats,
        loadYtDlpFormats,
    };
}