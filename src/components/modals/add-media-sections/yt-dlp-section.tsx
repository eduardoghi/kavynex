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
import { COOKIES_BROWSER_SELECT_OPTIONS } from "../../../constants/cookies-browsers";
import { formatBytes } from "../../../utils/media-utils";
import {
    type BadgeTone,
    buildFormatBadgeLabel,
    buildFormatBadgeTone,
    getBadgeStyle,
} from "../../../utils/yt-dlp-format-badge";
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
                disabled={isLocked || isLoadingYtDlpFormats}
            />

            <Select
                label="Authentication"
                placeholder="Optional"
                value={cookiesBrowser || null}
                onChange={(value) => onChangeCookiesBrowser(value ?? "")}
                data={COOKIES_BROWSER_SELECT_OPTIONS}
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