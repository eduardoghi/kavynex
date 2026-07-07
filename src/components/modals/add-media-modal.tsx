import {
    Modal,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import type { MediaSourceMode, MediaType, YtDlpFormat } from "../../types/media";
import { AddMediaModalActions } from "./add-media-sections/add-media-modal-actions";
import { LocalMediaSection } from "./add-media-sections/local-media-section";
import { ThumbnailSection } from "./add-media-sections/thumbnail-section";
import { YtDlpSection } from "./add-media-sections/yt-dlp-section";
import { YtDlpTerminal } from "./add-media-sections/yt-dlp-terminal";

type AddMediaModalProps = {
    opened: boolean;
    onClose: () => void;

    sourceMode: MediaSourceMode;
    mediaUrl: string;
    title: string;
    mediaPath: string;
    mediaType: MediaType;
    thumbPath: string;
    publishedAt: string;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    cookiesBrowser: string;
    cookiesPath: string;

    isGeneratingThumb: boolean;
    loading?: boolean;
    isCancellingYtDlp?: boolean;

    ytDlpLogs: string[];
    isYtDlpRunning: boolean;
    ytDlpFormats: YtDlpFormat[];
    selectedYtDlpFormatId: string;
    isLoadingYtDlpFormats: boolean;

    onChangeSourceMode: (value: MediaSourceMode) => void | Promise<void>;
    onChangeMediaUrl: (value: string) => void;
    onChangeTitle: (value: string) => void;
    onChangePublishedAt: (value: string) => void;
    onChangeDownloadComments: (value: boolean) => void;
    onChangeDownloadLiveChat: (value: boolean) => void;
    onChangeCookiesBrowser: (value: string) => void;
    onChangeCookiesPath: (value: string) => void;
    onPickCookiesFile: () => void | Promise<void>;
    onClearCookiesPath: () => void;
    onChangeSelectedYtDlpFormatId: (value: string) => void;
    onLoadYtDlpFormats: () => void | Promise<void>;
    onPickMedia: () => void;
    onPickThumb: () => void;
    onAdd: () => void;
    onCancelYtDlpDownload?: () => void | Promise<void>;
};

function formatPublishedAtForDisplay(value: string): string {
    const normalized = value.trim();

    if (!normalized) {
        return "";
    }

    const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (isoMatch) {
        const year = isoMatch[1];
        const month = isoMatch[2];
        const day = isoMatch[3];

        return `${day}/${month}/${year}`;
    }

    return normalized;
}

function normalizePublishedAtDigits(value: string): string {
    return value.replace(/\D/g, "").slice(0, 8);
}

function applyPublishedAtMask(value: string): string {
    const digits = normalizePublishedAtDigits(value);

    if (digits.length <= 2) {
        return digits;
    }

    if (digits.length <= 4) {
        return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    }

    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)}`;
}

function displayDateToIso(value: string): string {
    const normalized = value.trim();

    if (!normalized) {
        return "";
    }

    const match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

    if (!match) {
        return "";
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);

    if (
        !Number.isInteger(day) ||
        !Number.isInteger(month) ||
        !Number.isInteger(year) ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31
    ) {
        return "";
    }

    const date = new Date(year, month - 1, day);

    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        return "";
    }

    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function AddMediaModal({
    opened,
    onClose,
    sourceMode,
    mediaUrl,
    title,
    mediaPath,
    mediaType,
    thumbPath,
    publishedAt,
    downloadComments,
    downloadLiveChat,
    cookiesBrowser,
    cookiesPath,
    isGeneratingThumb,
    loading = false,
    isCancellingYtDlp = false,
    ytDlpLogs,
    isYtDlpRunning,
    ytDlpFormats,
    selectedYtDlpFormatId,
    isLoadingYtDlpFormats,
    onChangeSourceMode,
    onChangeMediaUrl,
    onChangeTitle,
    onChangePublishedAt,
    onChangeDownloadComments,
    onChangeDownloadLiveChat,
    onChangeCookiesBrowser,
    onChangeCookiesPath,
    onPickCookiesFile,
    onClearCookiesPath,
    onChangeSelectedYtDlpFormatId,
    onLoadYtDlpFormats,
    onPickMedia,
    onPickThumb,
    onAdd,
    onCancelYtDlpDownload,
}: AddMediaModalProps): JSX.Element {
    const isUrlMode = sourceMode === "yt-dlp";
    const canSelectThumb = isUrlMode ? true : mediaPath.trim() !== "";
    const isBusy = loading || isGeneratingThumb || isLoadingYtDlpFormats || isCancellingYtDlp;
    const isModalLocked =
        loading ||
        isGeneratingThumb ||
        isLoadingYtDlpFormats ||
        isYtDlpRunning ||
        isCancellingYtDlp;

    const canSubmit = isUrlMode
        ? mediaUrl.trim() !== "" && selectedYtDlpFormatId.trim() !== ""
        : mediaPath.trim() !== "";

    const formattedPublishedAt = useMemo(
        () => formatPublishedAtForDisplay(publishedAt),
        [publishedAt]
    );

    const [publishedAtInput, setPublishedAtInput] = useState(formattedPublishedAt);

    useEffect(() => {
        // Re-seed the local input only on an external reset (modal open/close or source-mode
        // switch), never on every publishedAt change. The user's own typing round-trips through
        // the parent as ISO, and an incomplete date (e.g. while deleting a digit) normalizes to
        // "", so depending on formattedPublishedAt here would wipe the partial text mid-edit.
        setPublishedAtInput(formattedPublishedAt);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: seed only when the modal re-opens or the source mode changes, not on each keystroke
    }, [opened, sourceMode]);

    const handleSubmit = (): void => {
        if (!canSubmit || isBusy || isYtDlpRunning) {
            return;
        }

        onAdd();
    };

    return (
        <Modal
            opened={opened}
            onClose={isModalLocked ? () => {} : onClose}
            title={<Text fw={900}>Import media</Text>}
            centered
            radius="lg"
            overlayProps={{ blur: 6 }}
            size={760}
            closeOnClickOutside={!isModalLocked}
            closeOnEscape={!isModalLocked}
            withCloseButton={!isModalLocked}
            zIndex={300}
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    handleSubmit();
                }}
            >
                <Stack gap="md">
                    <SegmentedControl
                        value={sourceMode}
                        onChange={(value) => void onChangeSourceMode(value as MediaSourceMode)}
                        data={[
                            { label: "Local file", value: "local" },
                            { label: "URL (yt-dlp)", value: "yt-dlp" },
                        ]}
                        disabled={isModalLocked}
                    />

                    <TextInput
                        label="Title"
                        placeholder={
                            isUrlMode
                                ? "Optional. If empty, the title from yt-dlp will be used"
                                : "e.g. Episode 01"
                        }
                        value={title}
                        onChange={(event) => onChangeTitle(event.currentTarget.value)}
                        disabled={isModalLocked}
                    />

                    {!isUrlMode && (
                        <TextInput
                            label="Published date"
                            placeholder="dd/mm/yyyy"
                            value={publishedAtInput}
                            onChange={(event) => {
                                const maskedValue = applyPublishedAtMask(event.currentTarget.value);

                                setPublishedAtInput(maskedValue);
                                onChangePublishedAt(displayDateToIso(maskedValue));
                            }}
                            disabled={isModalLocked}
                            description="Optional. Use this if you want to save the original publication date."
                            inputMode="numeric"
                            maxLength={10}
                        />
                    )}

                    {isUrlMode ? (
                        <YtDlpSection
                            mediaUrl={mediaUrl}
                            cookiesBrowser={cookiesBrowser}
                            cookiesPath={cookiesPath}
                            isLocked={isModalLocked}
                            isLoadingYtDlpFormats={isLoadingYtDlpFormats}
                            ytDlpFormats={ytDlpFormats}
                            selectedYtDlpFormatId={selectedYtDlpFormatId}
                            downloadComments={downloadComments}
                            downloadLiveChat={downloadLiveChat}
                            onChangeMediaUrl={onChangeMediaUrl}
                            onChangeCookiesBrowser={onChangeCookiesBrowser}
                            onChangeCookiesPath={onChangeCookiesPath}
                            onPickCookiesFile={onPickCookiesFile}
                            onClearCookiesPath={onClearCookiesPath}
                            onChangeSelectedYtDlpFormatId={onChangeSelectedYtDlpFormatId}
                            onChangeDownloadComments={onChangeDownloadComments}
                            onChangeDownloadLiveChat={onChangeDownloadLiveChat}
                            onLoadYtDlpFormats={onLoadYtDlpFormats}
                        />
                    ) : (
                        <LocalMediaSection
                            mediaPath={mediaPath}
                            mediaType={mediaType}
                            isLocked={isModalLocked}
                            onPickMedia={onPickMedia}
                        />
                    )}

                    <YtDlpTerminal
                        opened={opened}
                        visible={isUrlMode}
                        ytDlpLogs={ytDlpLogs}
                        isYtDlpRunning={isYtDlpRunning}
                    />

                    <ThumbnailSection
                        thumbPath={thumbPath}
                        mediaType={mediaType}
                        isGeneratingThumb={isGeneratingThumb}
                        isBusy={isBusy}
                        canSelectThumb={canSelectThumb}
                        isUrlMode={isUrlMode}
                        onPickThumb={onPickThumb}
                    />

                    <AddMediaModalActions
                        isYtDlpRunning={isYtDlpRunning}
                        isUrlMode={isUrlMode}
                        isCancellingYtDlp={isCancellingYtDlp}
                        isModalLocked={isModalLocked}
                        canSubmit={canSubmit}
                        isBusy={isBusy}
                        loading={loading}
                        onCancelYtDlpDownload={onCancelYtDlpDownload}
                        onClose={onClose}
                    />
                </Stack>
            </form>
        </Modal>
    );
}