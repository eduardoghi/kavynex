import { memo, useEffect, useRef } from "react";
import {
    Box,
    Checkbox,
    Group,
    Select,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";
import { Link as LinkIcon, ListVideo } from "lucide-react";
import type { YtDlpFormatOption } from "../../../types/media";
import { formatBytes } from "../../../utils/media-utils";
import { AppButton } from "../../ui/app-button";
import { CookiesFields } from "./cookies-fields";

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


function YtDlpSectionView({
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

    // The URL field and the Load button are disabled while the formats load, and focus on either
    // fell to the page with nothing to bring it back. Once the load ends it returns to the field,
    // unless the user has put it somewhere else meanwhile.
    const urlInputRef = useRef<HTMLInputElement>(null);
    const wasLoading = useRef(isLoadingYtDlpFormats);

    useEffect(() => {
        const loadEnded = wasLoading.current && !isLoadingYtDlpFormats;
        wasLoading.current = isLoadingYtDlpFormats;

        if (!loadEnded) {
            return;
        }

        const active = document.activeElement;

        if (active && active !== document.body && document.contains(active)) {
            return;
        }

        urlInputRef.current?.focus();
    }, [isLoadingYtDlpFormats]);

    return (
        <Stack gap="sm">
            <TextInput
                ref={urlInputRef}
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

            <CookiesFields
                cookiesBrowser={cookiesBrowser}
                cookiesBrowserProfile={cookiesBrowserProfile}
                cookiesPath={cookiesPath}
                isLocked={isLocked}
                onChangeCookiesBrowser={onChangeCookiesBrowser}
                onChangeCookiesBrowserProfile={onChangeCookiesBrowserProfile}
                onPickCookiesFile={onPickCookiesFile}
                onClearCookiesPath={onClearCookiesPath}
            />

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
                description="Fetched after the download, up to 100,000 per media. A video with many can take a few minutes, and Skip comments stops it without losing the media."
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

// Memoized because the modal re-renders on every yt-dlp log line (the terminal it holds), and
// none of this section's props change with the log.
export const YtDlpSection = memo(YtDlpSectionView);
