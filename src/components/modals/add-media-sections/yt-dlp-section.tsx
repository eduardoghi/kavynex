import {
    ActionIcon,
    Badge,
    Box,
    Checkbox,
    Group,
    Select,
    Stack,
    Text,
    TextInput,
    rem,
} from "@mantine/core";
import { FileText, Link as LinkIcon, ListVideo, X } from "lucide-react";
import type { ReactNode } from "react";
import type { YtDlpFormat } from "../../../types/media";
import { formatBytes } from "../../../utils/media-utils";
import { AppButton } from "../../ui/app-button";

type YtDlpSectionProps = {
    mediaUrl: string;
    cookiesBrowser: string;
    cookiesPath: string;
    isLocked: boolean;
    isLoadingYtDlpFormats: boolean;
    ytDlpFormats: YtDlpFormat[];
    selectedYtDlpFormatId: string;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    onChangeMediaUrl: (value: string) => void;
    onChangeCookiesBrowser: (value: string) => void;
    onChangeCookiesPath: (value: string) => void;
    onPickCookiesFile: () => void | Promise<void>;
    onClearCookiesPath: () => void;
    onChangeSelectedYtDlpFormatId: (value: string) => void;
    onChangeDownloadComments: (value: boolean) => void;
    onChangeDownloadLiveChat: (value: boolean) => void;
    onLoadYtDlpFormats: () => void | Promise<void>;
};

type BadgeTone = "neutral" | "violet" | "blue" | "green" | "orange" | "red" | "yellow";

function buildFormatBadgeLabel(format: YtDlpFormat | null): string {
    if (!format) {
        return "NO FORMAT SELECTED";
    }

    const displayName = format.display_name.trim().toUpperCase();

    if (displayName.startsWith("MERGED")) {
        return "MERGED";
    }

    if (displayName.startsWith("NATIVE")) {
        return "NATIVE";
    }

    if (displayName.startsWith("VIDEO ONLY")) {
        return "VIDEO ONLY";
    }

    if (displayName.startsWith("AUDIO ONLY")) {
        return "AUDIO ONLY";
    }

    if (format.has_video && format.has_audio) {
        return "VIDEO + AUDIO";
    }

    if (format.has_video) {
        return "VIDEO ONLY";
    }

    return "AUDIO ONLY";
}

function buildFormatBadgeTone(format: YtDlpFormat | null): BadgeTone {
    if (!format) {
        return "neutral";
    }

    const displayName = format.display_name.trim().toUpperCase();

    if (displayName.startsWith("MERGED")) {
        return "violet";
    }

    if (displayName.startsWith("NATIVE")) {
        return "green";
    }

    if (displayName.startsWith("VIDEO ONLY")) {
        return "blue";
    }

    if (displayName.startsWith("AUDIO ONLY")) {
        return "orange";
    }

    if (format.has_video && format.has_audio) {
        return "green";
    }

    if (format.has_video) {
        return "blue";
    }

    return "orange";
}

function getBadgeStyle(tone: BadgeTone): {
    background: string;
    borderColor: string;
    color: string;
} {
    if (tone === "violet") {
        return {
            background: "rgba(124,92,255,0.13)",
            borderColor: "rgba(139,92,246,0.34)",
            color: "rgb(221,214,254)",
        };
    }

    if (tone === "blue") {
        return {
            background: "rgba(59,130,246,0.13)",
            borderColor: "rgba(59,130,246,0.34)",
            color: "rgb(147,197,253)",
        };
    }

    if (tone === "green") {
        return {
            background: "rgba(34,197,94,0.13)",
            borderColor: "rgba(34,197,94,0.34)",
            color: "rgb(134,239,172)",
        };
    }

    if (tone === "orange") {
        return {
            background: "rgba(249,115,22,0.13)",
            borderColor: "rgba(249,115,22,0.34)",
            color: "rgb(253,186,116)",
        };
    }

    if (tone === "red") {
        return {
            background: "rgba(239,68,68,0.13)",
            borderColor: "rgba(239,68,68,0.34)",
            color: "rgb(252,165,165)",
        };
    }

    if (tone === "yellow") {
        return {
            background: "rgba(234,179,8,0.13)",
            borderColor: "rgba(234,179,8,0.34)",
            color: "rgb(253,224,71)",
        };
    }

    return {
        background: "rgba(255,255,255,0.055)",
        borderColor: "rgba(255,255,255,0.14)",
        color: "rgba(255,255,255,0.66)",
    };
}

function StatusBadge({
    children,
    tone,
}: {
    children: ReactNode;
    tone: BadgeTone;
}): JSX.Element {
    const badgeStyle = getBadgeStyle(tone);

    return (
        <Badge
            variant="outline"
            style={{
                flexShrink: 0,
                paddingInline: rem(8),
                background: badgeStyle.background,
                borderColor: badgeStyle.borderColor,
                color: badgeStyle.color,
                fontWeight: 800,
            }}
        >
            {children}
        </Badge>
    );
}

export function YtDlpSection({
    mediaUrl,
    cookiesBrowser,
    cookiesPath,
    isLocked,
    isLoadingYtDlpFormats,
    ytDlpFormats,
    selectedYtDlpFormatId,
    downloadComments,
    downloadLiveChat,
    onChangeMediaUrl,
    onChangeCookiesBrowser,
    onChangeCookiesPath,
    onPickCookiesFile,
    onClearCookiesPath,
    onChangeSelectedYtDlpFormatId,
    onChangeDownloadComments,
    onChangeDownloadLiveChat,
    onLoadYtDlpFormats,
}: YtDlpSectionProps): JSX.Element {
    const selectedFormat =
        ytDlpFormats.find((item) => item.format_id === selectedYtDlpFormatId) ?? null;

    const canLoadFormats = mediaUrl.trim() !== "" && !isLocked && !isLoadingYtDlpFormats;
    const isManualCookies = cookiesBrowser === "manual";

    return (
        <Stack gap="sm">
            <TextInput
                label="Media URL"
                placeholder="https://www.youtube.com/watch?v=..."
                value={mediaUrl}
                onChange={(event) => onChangeMediaUrl(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && canLoadFormats) {
                        event.preventDefault();
                        void onLoadYtDlpFormats();
                    }
                }}
                leftSection={<LinkIcon size={16} />}
                disabled={isLocked}
            />

            <Select
                label="Authentication"
                placeholder="Optional"
                value={cookiesBrowser || null}
                onChange={(value) => onChangeCookiesBrowser(value ?? "")}
                data={[
                    { value: "edge", label: "Edge" },
                    { value: "firefox", label: "Firefox" },
                    { value: "brave", label: "Brave" },
                    { value: "opera", label: "Opera" },
                    { value: "manual", label: "Manual cookies file" },
                ]}
                clearable
                disabled={isLocked}
                description="Use this only when YouTube asks for authentication."
            />

            {isManualCookies && (
                <Group align="end" wrap="nowrap">
                    <TextInput
                        label="Cookies file"
                        placeholder="Choose a cookies.txt file"
                        value={cookiesPath}
                        onChange={(event) => onChangeCookiesPath(event.currentTarget.value)}
                        leftSection={<FileText size={16} />}
                        readOnly
                        style={{ flex: 1 }}
                    />

                    <AppButton
                        type="button"
                        appVariant="secondary"
                        onClick={() => void onPickCookiesFile()}
                        disabled={isLocked}
                    >
                        Choose file
                    </AppButton>

                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="lg"
                        aria-label="Clear cookies file"
                        onClick={onClearCookiesPath}
                        disabled={isLocked || !cookiesPath.trim()}
                    >
                        <X size={18} />
                    </ActionIcon>
                </Group>
            )}

            <Group justify="space-between" align="end" wrap="nowrap">
                <Box style={{ flex: 1 }}>
                    <Text size="sm" c="dimmed">
                        Load the available formats first. Then choose the media stream, quality,
                        and estimated size before importing.
                    </Text>
                </Box>

                <AppButton
                    type="button"
                    appVariant="secondary"
                    leftSection={<ListVideo size={16} />}
                    onClick={() => void onLoadYtDlpFormats()}
                    loading={isLoadingYtDlpFormats}
                    disabled={!canLoadFormats}
                >
                    Load formats
                </AppButton>
            </Group>

            <Select
                label="Available formats"
                placeholder={
                    ytDlpFormats.length > 0
                        ? "Choose a format"
                        : "Load formats to see the available options"
                }
                value={selectedYtDlpFormatId || null}
                onChange={(value) => onChangeSelectedYtDlpFormatId(value ?? "")}
                data={ytDlpFormats.map((item) => ({
                    value: item.format_id,
                    label: `${item.display_name} • ${formatBytes(item.filesize_bytes)}`,
                }))}
                searchable
                nothingFoundMessage="No formats found"
                disabled={isLocked || ytDlpFormats.length === 0}
            />

            <Checkbox
                label="Save YouTube comments"
                description="When enabled, the app fetches and stores comments during import."
                checked={downloadComments}
                onChange={(event) => onChangeDownloadComments(event.currentTarget.checked)}
                disabled={isLocked}
            />

            <Checkbox
                label="Save live chat"
                description="When enabled, the app fetches and stores the live chat replay during import."
                checked={downloadLiveChat}
                onChange={(event) => onChangeDownloadLiveChat(event.currentTarget.checked)}
                disabled={isLocked}
            />

            <Group gap="xs" wrap="wrap">
                <StatusBadge tone={ytDlpFormats.length > 0 ? "violet" : "neutral"}>
                    {ytDlpFormats.length} FORMAT(S)
                </StatusBadge>

                <StatusBadge tone={buildFormatBadgeTone(selectedFormat)}>
                    {buildFormatBadgeLabel(selectedFormat)}
                </StatusBadge>

                <StatusBadge tone={selectedFormat ? "green" : "neutral"}>
                    {selectedFormat
                        ? formatBytes(selectedFormat.filesize_bytes).toUpperCase()
                        : "SIZE UNKNOWN"}
                </StatusBadge>

                <StatusBadge tone={downloadComments ? "violet" : "neutral"}>
                    {downloadComments ? "COMMENTS ON" : "COMMENTS OFF"}
                </StatusBadge>

                <StatusBadge tone={downloadLiveChat ? "red" : "neutral"}>
                    {downloadLiveChat ? "LIVE CHAT ON" : "LIVE CHAT OFF"}
                </StatusBadge>

                <StatusBadge tone={cookiesBrowser ? "blue" : "neutral"}>
                    {cookiesBrowser
                        ? cookiesBrowser === "manual"
                            ? "COOKIES: MANUAL"
                            : `COOKIES: ${cookiesBrowser.toUpperCase()}`
                        : "NO COOKIES"}
                </StatusBadge>
            </Group>

            {selectedFormat && (
                <Box
                    style={{
                        borderRadius: rem(14),
                        border: "1px solid rgba(255,255,255,0.12)",
                        background: "rgba(255,255,255,0.02)",
                        padding: rem(12),
                    }}
                >
                    <Stack gap={4}>
                        <Text fw={800}>Selected format</Text>

                        <Text size="sm">{selectedFormat.display_name}</Text>

                        <Text size="sm" c="dimmed">
                            Format id: {selectedFormat.format_id} · Extension:{" "}
                            {selectedFormat.ext.toUpperCase()} · Estimated size:{" "}
                            {formatBytes(selectedFormat.filesize_bytes)}
                        </Text>
                    </Stack>
                </Box>
            )}
        </Stack>
    );
}