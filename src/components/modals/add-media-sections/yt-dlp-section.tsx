import {
    ActionIcon,
    Box,
    Checkbox,
    Group,
    Select,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";
import { FileText, Link as LinkIcon, ListVideo, X } from "lucide-react";
import type { YtDlpFormatOption } from "../../../types/media";
import { COOKIES_BROWSER_SELECT_OPTIONS } from "../../../constants/cookies-browsers";
import { formatBytes } from "../../../utils/media-utils";
import { AppButton } from "../../ui/app-button";

type YtDlpSectionProps = {
    mediaUrl: string;
    cookiesBrowser: string;
    cookiesBrowserProfile: string;
    cookiesPath: string;
    isLocked: boolean;
    isLoadingYtDlpFormats: boolean;
    ytDlpFormats: YtDlpFormatOption[];
    selectedYtDlpFormatId: string;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    onChangeMediaUrl: (value: string) => void;
    onChangeCookiesBrowser: (value: string) => void;
    onChangeCookiesBrowserProfile: (value: string) => void;
    onPickCookiesFile: () => void | Promise<void>;
    onClearCookiesPath: () => void;
    onChangeSelectedYtDlpFormatId: (value: string) => void;
    onChangeDownloadComments: (value: boolean) => void;
    onChangeDownloadLiveChat: (value: boolean) => void;
    onLoadYtDlpFormats: () => void | Promise<void>;
};


export function YtDlpSection({
    mediaUrl,
    cookiesBrowser,
    cookiesBrowserProfile,
    cookiesPath,
    isLocked,
    isLoadingYtDlpFormats,
    ytDlpFormats,
    selectedYtDlpFormatId,
    downloadComments,
    downloadLiveChat,
    onChangeMediaUrl,
    onChangeCookiesBrowser,
    onChangeCookiesBrowserProfile,
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
    const isBrowserCookies = cookiesBrowser !== "" && !isManualCookies;

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
                label="YouTube authentication"
                placeholder="Optional"
                value={cookiesBrowser || null}
                onChange={(value) => onChangeCookiesBrowser(value ?? "")}
                data={COOKIES_BROWSER_SELECT_OPTIONS}
                clearable
                disabled={isLocked}
                description="Use this only when YouTube asks for authentication."
            />

            {/* Only needed when the browser has more than one profile, so it appears only once a
                browser is chosen and stays optional. A single field carries yt-dlp's whole
                BROWSER[+KEYRING][:PROFILE][::CONTAINER] grammar (the browser is prepended), since a
                second control for the keyring would serve the rarest case of the three. */}
            {isBrowserCookies && (
                <TextInput
                    label="Browser profile"
                    placeholder="Optional. Profile name or path, for example default-release"
                    value={cookiesBrowserProfile}
                    onChange={(event) => onChangeCookiesBrowserProfile(event.currentTarget.value)}
                    disabled={isLocked}
                    description="Leave empty to use the browser's default profile. Add ::Name for a Firefox container, or start with +keyring (for example +gnomekeyring:Default) on Linux."
                />
            )}

            {isManualCookies && (
                <Group align="end" wrap="nowrap">
                    <TextInput
                        label="Cookies file"
                        placeholder="Choose a cookies.txt file"
                        value={cookiesPath}
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

                {/* Filled only while it is the next thing to do. Once formats are loaded
                    the next step is Add media, and two filled buttons on one screen say
                    nothing about which. */}
                <AppButton
                    type="button"
                    appVariant={
                        canLoadFormats && ytDlpFormats.length === 0
                            ? "primary"
                            : "secondary"
                    }
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

            {/* The option text above already carries the stream, resolution, container,
                codec, bitrate, protocol and size, so the id is the one thing worth adding
                under it. A panel at the foot of the section used to repeat all of them. */}
            {selectedFormat && (
                <Text size="xs" c="dimmed">
                    Format ID: {selectedFormat.format_id}
                </Text>
            )}

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
        </Stack>
    );
}