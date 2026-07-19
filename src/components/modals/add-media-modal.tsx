import {
    Modal,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import type { MediaSourceMode, MediaType, YtDlpFormatOption } from "../../types/media";
import { AddMediaModalActions } from "./add-media-sections/add-media-modal-actions";
import { LocalMediaSection } from "./add-media-sections/local-media-section";
import { ThumbnailSection } from "./add-media-sections/thumbnail-section";
import { YtDlpSection } from "./add-media-sections/yt-dlp-section";
import { YtDlpTerminal } from "./add-media-sections/yt-dlp-terminal";
import {
    applyPublishedAtMask,
    displayDateToIso,
    formatPublishedAtForDisplay,
} from "../../utils/published-date";
import { toUnionValue } from "../../utils/guards";
import { useModalLock } from "../../hooks/use-modal-lock";

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
    ytDlpFormats: YtDlpFormatOption[];
    selectedYtDlpFormatId: string;
    isLoadingYtDlpFormats: boolean;

    onChangeSourceMode: (value: MediaSourceMode) => void | Promise<void>;
    onChangeMediaUrl: (value: string) => void;
    onChangeTitle: (value: string) => void;
    onChangePublishedAt: (value: string) => void;
    onChangeDownloadComments: (value: boolean) => void;
    onChangeDownloadLiveChat: (value: boolean) => void;
    onChangeCookiesBrowser: (value: string) => void;
    onPickCookiesFile: () => void | Promise<void>;
    onClearCookiesPath: () => void;
    onChangeSelectedYtDlpFormatId: (value: string) => void;
    onLoadYtDlpFormats: () => void | Promise<void>;
    onPickMedia: () => void;
    onPickThumb: () => void;
    onAdd: () => void;
    onCancelYtDlpDownload?: () => void | Promise<void>;
};

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

    const modalLock = useModalLock(isModalLocked, onClose);

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
            {...modalLock}
            title={<Text fw={900}>Import media</Text>}
            centered
            radius="lg"
            overlayProps={{ blur: 6 }}
            size={760}
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
                        onChange={(value) =>
                            void onChangeSourceMode(
                                toUnionValue(value, ["local", "yt-dlp"] as const, "local")
                            )
                        }
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