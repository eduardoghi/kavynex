import {
    Modal,
    ScrollArea,
    SegmentedControl,
    Stack,
    TextInput,
} from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import type { MediaSourceMode, MediaType, YtDlpFormatOption } from "../../types/media";
import { AddMediaModalActions } from "./add-media-sections/add-media-modal-actions";
import { ExternalToolsWarning } from "./add-media-sections/external-tools-warning";
import { LocalMediaSection } from "./add-media-sections/local-media-section";
import { ThumbnailSection } from "./add-media-sections/thumbnail-section";
import { YtDlpSection } from "./add-media-sections/yt-dlp-section";
import { YtDlpTerminal } from "./add-media-sections/yt-dlp-terminal";
import type { YtDlpLogLine } from "../../hooks/use-yt-dlp-events";
import type { YtDlpProgress } from "../../services/yt-dlp-progress";
import {
    applyPublishedAtMask,
    displayDateToIso,
    formatPublishedAtForDisplay,
} from "../../utils/published-date";
import { toUnionValue } from "../../utils/guards";
import { useExternalToolsAvailability } from "../../hooks/use-external-tools-availability";
import { useModalLock } from "../../hooks/use-modal-lock";
import { MODAL_CLOSE_BUTTON_STYLE, MODAL_TITLE_STYLE } from "../ui/modal-chrome";

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
    cookiesBrowserProfile: string;
    cookiesPath: string;

    isGeneratingThumb: boolean;
    loading?: boolean;
    isCancellingYtDlp?: boolean;

    ytDlpLogs: YtDlpLogLine[];
    isYtDlpRunning: boolean;
    ytDlpProgress: YtDlpProgress | null;
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
    onChangeCookiesBrowserProfile: (value: string) => void;
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
    cookiesBrowserProfile,
    cookiesPath,
    isGeneratingThumb,
    loading = false,
    isCancellingYtDlp = false,
    ytDlpLogs,
    isYtDlpRunning,
    ytDlpProgress,
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
    onChangeCookiesBrowserProfile,
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

    // The terminal is the only part of this form that wants a tall dialog, and only once
    // it has something in it. Before that, URL mode is a form like any other and the fixed
    // height left a large empty block under the footer.
    const needsTerminalRoom =
        isUrlMode && (isYtDlpRunning || ytDlpLogs.length > 0);
    const canSelectThumb = isUrlMode ? true : mediaPath.trim() !== "";
    const isBusy = loading || isGeneratingThumb || isLoadingYtDlpFormats || isCancellingYtDlp;
    const isModalLocked =
        loading ||
        isGeneratingThumb ||
        isLoadingYtDlpFormats ||
        isYtDlpRunning ||
        isCancellingYtDlp;

    const modalLock = useModalLock(isModalLocked, onClose);

    // Probed while the modal is open rather than on every launch. It spawns both binaries, and the
    // answer only matters to someone who is about to import something.
    const { missingTools } = useExternalToolsAvailability(opened, sourceMode);

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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional. Seed only when the modal re-opens or the source mode changes, not on each keystroke
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
            title="Import media"
            centered
            radius="lg"
            overlayProps={{ blur: 6 }}
            // Sized off the viewport like the diagnostics modal rather than pinned to a fixed 760px.
            // On a large window that cap left most of the screen empty while the body scrolled, and
            // this form has two elements that genuinely want the width. The format option
            // ("Merged · 1080p · MP4 · AVC (H.264) · 2638.3 kbps · HTTPS · 1.43 GB") and the terminal's
            // yt-dlp command line, both of which wrapped at 760px. Kept under diagnostics' 1200px
            // because the rest is short inputs, which look stretched past roughly this width.
            size="min(1040px, 94vw)"
            zIndex={300}
            // Cap the modal to the viewport and scroll the body inside it (same pattern the settings
            // and diagnostics modals use). A fixed height makes the flex chain definite so the inner
            // ScrollArea can size to it. `display: contents` on the form keeps that ScrollArea a
            // direct flex child of the modal body. Without this the whole viewport-height wrapper
            // scrolls, putting the scrollbar at the window edge and running a tall form past the
            // screen. offsetScrollbars keeps the bar clear of the rounded corners.
            styles={{
                title: MODAL_TITLE_STYLE,
                content: {
                    // A ceiling rather than a height until the terminal has output, so the
                    // modal ends where the form does. Once logs arrive it takes the fixed
                    // height and scrolls inside, which is what the terminal wants.
                    ...(needsTerminalRoom
                        ? { height: "min(90vh, 980px)" }
                        : { maxHeight: "min(90vh, 980px)" }),
                    display: "flex",
                    flexDirection: "column",
                },
                body: {
                    flex: 1,
                    minHeight: 0,
                    // The ScrollArea owns the scrolling when it has a height to scroll
                    // within. In local mode it has none, so the body takes over for the
                    // rare case where a missing-tool alert pushes the form past the ceiling.
                    overflow: needsTerminalRoom ? "hidden" : "auto",
                },
            }}
            closeButtonProps={{
                "aria-label": "Close import media",
                style: MODAL_CLOSE_BUTTON_STYLE,
            }}
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    handleSubmit();
                }}
                style={{ display: "contents" }}
            >
                <ScrollArea
                    h={needsTerminalRoom ? "100%" : undefined}
                    offsetScrollbars
                    scrollbarSize={10}
                    type="always"
                >
                    <Stack gap="md" pr="xs">
                        <ExternalToolsWarning missingTools={missingTools} />

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
                                cookiesBrowserProfile={cookiesBrowserProfile}
                                cookiesPath={cookiesPath}
                                isLocked={isModalLocked}
                                isLoadingYtDlpFormats={isLoadingYtDlpFormats}
                                ytDlpFormats={ytDlpFormats}
                                selectedYtDlpFormatId={selectedYtDlpFormatId}
                                downloadComments={downloadComments}
                                downloadLiveChat={downloadLiveChat}
                                onChangeMediaUrl={onChangeMediaUrl}
                                onChangeCookiesBrowser={onChangeCookiesBrowser}
                                onChangeCookiesBrowserProfile={onChangeCookiesBrowserProfile}
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

                        {/* Above the terminal. Picking a thumbnail is part of setting the
                            import up, and it was sitting after the log of the run it
                            configures. */}
                        <ThumbnailSection
                            thumbPath={thumbPath}
                            mediaType={mediaType}
                            isGeneratingThumb={isGeneratingThumb}
                            isBusy={isBusy}
                            canSelectThumb={canSelectThumb}
                            isUrlMode={isUrlMode}
                            onPickThumb={onPickThumb}
                        />

                        <YtDlpTerminal
                            opened={opened}
                            visible={isUrlMode}
                            ytDlpLogs={ytDlpLogs}
                            isYtDlpRunning={isYtDlpRunning}
                            isImporting={loading}
                            ytDlpProgress={ytDlpProgress}
                        />

                        <AddMediaModalActions
                            isYtDlpRunning={isYtDlpRunning}
                            isUrlMode={isUrlMode}
                            // `loading` is the add itself being in flight (home-modals passes
                            // isAddingMedia), so in local mode it is exactly "an import is running".
                            // No new prop had to be threaded down for this.
                            isImportingLocalFile={!isUrlMode && Boolean(loading)}
                            isCancellingYtDlp={isCancellingYtDlp}
                            isModalLocked={isModalLocked}
                            canSubmit={canSubmit}
                            isBusy={isBusy}
                            loading={loading}
                            onCancelYtDlpDownload={onCancelYtDlpDownload}
                            onClose={onClose}
                        />
                    </Stack>
                </ScrollArea>
            </form>
        </Modal>
    );
}