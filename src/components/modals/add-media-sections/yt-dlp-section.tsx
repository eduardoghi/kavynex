import {
    ActionIcon,
    Badge,
    Box,
    Button,
    Checkbox,
    Group,
    Select,
    Stack,
    Text,
    TextInput,
    rem,
} from "@mantine/core";
import { FileText, Link as LinkIcon, ListVideo, X } from "lucide-react";
import type { YtDlpFormat } from "../../../types/media";
import { formatBytes } from "../../../utils/media-utils";

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

function buildFormatBadgeColor(format: YtDlpFormat | null): string {
    if (!format) {
        return "gray";
    }

    const displayName = format.display_name.trim().toUpperCase();

    if (displayName.startsWith("MERGED")) {
        return "violet";
    }

    if (displayName.startsWith("NATIVE")) {
        return "green";
    }

    if (displayName.startsWith("VIDEO ONLY")) {
        return "cyan";
    }

    if (displayName.startsWith("AUDIO ONLY")) {
        return "orange";
    }

    if (format.has_video && format.has_audio) {
        return "green";
    }

    if (format.has_video) {
        return "cyan";
    }

    return "orange";
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

                    <Button
                        variant="default"
                        onClick={() => void onPickCookiesFile()}
                        disabled={isLocked}
                    >
                        Choose file
                    </Button>

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

                <Button
                    variant="default"
                    leftSection={<ListVideo size={16} />}
                    onClick={() => void onLoadYtDlpFormats()}
                    loading={isLoadingYtDlpFormats}
                    disabled={!canLoadFormats}
                >
                    Load formats
                </Button>
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

            <Group gap="xs">
                <Badge variant="light" color={ytDlpFormats.length > 0 ? "violet" : "gray"}>
                    {ytDlpFormats.length} format(s)
                </Badge>

                <Badge
                    variant="light"
                    color={buildFormatBadgeColor(selectedFormat)}
                >
                    {buildFormatBadgeLabel(selectedFormat)}
                </Badge>

                <Badge variant="light" color={selectedFormat ? "green" : "gray"}>
                    {selectedFormat
                        ? formatBytes(selectedFormat.filesize_bytes)
                        : "size unknown"}
                </Badge>

                <Badge variant="light" color={downloadComments ? "violet" : "gray"}>
                    {downloadComments ? "COMMENTS ON" : "COMMENTS OFF"}
                </Badge>

                <Badge variant="light" color={downloadLiveChat ? "red" : "gray"}>
                    {downloadLiveChat ? "LIVE CHAT ON" : "LIVE CHAT OFF"}
                </Badge>

                <Badge variant="light" color={cookiesBrowser ? "blue" : "gray"}>
                    {cookiesBrowser
                        ? cookiesBrowser === "manual"
                            ? "COOKIES: MANUAL"
                            : `COOKIES: ${cookiesBrowser.toUpperCase()}`
                        : "NO COOKIES"}
                </Badge>
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

                        <Text size="sm">
                            {selectedFormat.display_name}
                        </Text>

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