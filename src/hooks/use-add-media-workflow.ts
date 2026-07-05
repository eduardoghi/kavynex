import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportMode } from "../types/settings";
import { cancelMediaDownload, createMedia } from "../services";
import { useAddMediaForm } from "./use-add-media-form";
import { useAsyncFlag } from "./use-async-flag";
import { useYtDlpEvents } from "./use-yt-dlp-events";
import { resolveErrorMessage } from "../utils/error-message";
import { logError } from "../utils/app-logger";

type UseAddMediaWorkflowOptions = {
    selectedChannelId: number | null;
    importMode: ImportMode;
    libraryPath: string;
    onError: (message: string) => void;
    onReloadMedia: (channelId?: number | null) => Promise<void>;
};

type UseAddMediaWorkflowReturn = {
    addMediaOpen: boolean;
    setAddMediaOpen: React.Dispatch<React.SetStateAction<boolean>>;
    isAddingMedia: boolean;
    isCancellingYtDlp: boolean;
    ytDlpLogs: string[];
    isYtDlpRunning: boolean;
    addMediaForm: ReturnType<typeof useAddMediaForm>;
    addMedia: () => Promise<void>;
    cancelYtDlpDownload: () => Promise<void>;
    closeAddMediaModal: () => Promise<void>;
};

export function useAddMediaWorkflow({
    selectedChannelId,
    importMode,
    libraryPath,
    onError,
    onReloadMedia,
}: UseAddMediaWorkflowOptions): UseAddMediaWorkflowReturn {
    const [addMediaOpen, setAddMediaOpen] = useState(false);

    // Both operations guard reentrancy through useAsyncFlag, whose ref is set before any
    // await: two synchronous invocations can never both pass the guard, so a double
    // click cannot start two downloads (each with its own run id).
    const { isRunning: isAddingMedia, runWithFlag: runAddMedia } = useAsyncFlag();
    const {
        isRunning: isCancellingYtDlp,
        runWithFlag: runCancelYtDlp,
        resetFlag: resetCancellingYtDlp,
    } = useAsyncFlag();

    const wasAddMediaOpenRef = useRef(false);
    const previousSelectedChannelIdRef = useRef<number | null>(selectedChannelId);

    const ytDlpEvents = useYtDlpEvents();

    const addMediaForm = useAddMediaForm({
        onError,
        ytDlpTerminal: {
            startManualSession: ytDlpEvents.startManualSession,
            appendManualLog: ytDlpEvents.appendManualLog,
            markStopped: ytDlpEvents.markStopped,
            resetYtDlpState: ytDlpEvents.resetYtDlpState,
        },
    });

    const addMedia = useCallback(async (): Promise<void> => {
        if (selectedChannelId === null) {
            onError("Select a channel before adding media.");
            return;
        }

        const isPreparingMedia =
            addMediaForm.isGeneratingThumb || addMediaForm.isLoadingYtDlpFormats;

        if (isCancellingYtDlp || isPreparingMedia || ytDlpEvents.isYtDlpRunning) {
            return;
        }

        const sourceMode = addMediaForm.sourceMode;
        const sourceValue =
            sourceMode === "yt-dlp" ? addMediaForm.mediaUrl.trim() : addMediaForm.mediaPath.trim();

        if (!sourceValue) {
            onError(
                sourceMode === "yt-dlp"
                    ? "Enter a media URL before continuing."
                    : "Select a media file before continuing."
            );
            return;
        }

        if (sourceMode === "yt-dlp" && !addMediaForm.selectedYtDlpFormatId.trim()) {
            onError("Load the available formats and choose one before continuing.");
            return;
        }

        await runAddMedia(async () => {
            try {
                let ytDlpRunId = "";
                let ytDlpFormatId = "";

                if (sourceMode === "yt-dlp") {
                    ytDlpRunId =
                        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
                            ? crypto.randomUUID()
                            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

                    ytDlpFormatId = addMediaForm.selectedYtDlpFormatId.trim();

                    const commandPreview = addMediaForm.cookiesBrowser
                        ? `yt-dlp ${addMediaForm.mediaUrl.trim()} --cookies-from-browser ${addMediaForm.cookiesBrowser} --format ${ytDlpFormatId}`
                        : `yt-dlp ${addMediaForm.mediaUrl.trim()} --format ${ytDlpFormatId}`;

                    ytDlpEvents.startRun(ytDlpRunId, commandPreview);

                    ytDlpEvents.appendManualLog(
                        addMediaForm.downloadComments
                            ? "Comments: enabled"
                            : "Comments: disabled"
                    );

                    ytDlpEvents.appendManualLog(
                        addMediaForm.downloadLiveChat
                            ? "Live chat: enabled"
                            : "Live chat: disabled"
                    );

                    if (addMediaForm.cookiesBrowser) {
                        ytDlpEvents.appendManualLog(
                            `Cookies from browser: ${addMediaForm.cookiesBrowser}`
                        );
                    }
                }

                await createMedia(
                    {
                        channelId: selectedChannelId,
                        title: addMediaForm.title.trim(),
                        sourceMode,
                        sourceValue,
                        thumbnailSourcePath: addMediaForm.thumbPath || null,
                        mediaType:
                            sourceMode === "yt-dlp"
                                ? addMediaForm.selectedYtDlpMediaType
                                : addMediaForm.mediaType,
                        importMode,
                        libraryPath,
                        publishedAt:
                            sourceMode === "yt-dlp"
                                ? null
                                : addMediaForm.publishedAt.trim() || null,
                        ytDlpRunId,
                        ytDlpFormatId,
                        downloadComments: addMediaForm.downloadComments,
                        downloadLiveChat: addMediaForm.downloadLiveChat,
                        cookiesBrowser: addMediaForm.cookiesBrowser || null,
                    },
                    {
                        onProgress: (message) => {
                            ytDlpEvents.appendManualLog(message);
                        },
                    }
                );

                await onReloadMedia(selectedChannelId);
                await addMediaForm.resetForm();

                setAddMediaOpen(false);
            } catch (error) {
                ytDlpEvents.markStopped();

                logError("add-media", "Failed to add media.", error, {
                    selectedChannelId,
                    sourceMode: addMediaForm.sourceMode,
                    libraryPath,
                    cookiesBrowser: addMediaForm.cookiesBrowser,
                });
                onError(resolveErrorMessage(error, "Failed to add media."));
            }
        });
    }, [
        addMediaForm,
        importMode,
        isCancellingYtDlp,
        libraryPath,
        onError,
        onReloadMedia,
        runAddMedia,
        selectedChannelId,
        ytDlpEvents,
    ]);

    const cancelYtDlpDownload = useCallback(async (): Promise<void> => {
        const runId = ytDlpEvents.currentRunIdRef.current.trim();

        if (!runId || !ytDlpEvents.isYtDlpRunning) {
            return;
        }

        await runCancelYtDlp(async () => {
            try {
                await cancelMediaDownload(runId);
            } catch (error) {
                logError("add-media", "Failed to cancel media download.", error, {
                    runId,
                });
                onError(resolveErrorMessage(error, "Failed to cancel media download."));
            }
        });
    }, [onError, runCancelYtDlp, ytDlpEvents]);

    const closeAddMediaModal = useCallback(async (): Promise<void> => {
        const isModalLocked =
            isAddingMedia ||
            ytDlpEvents.isYtDlpRunning ||
            isCancellingYtDlp ||
            addMediaForm.isGeneratingThumb ||
            addMediaForm.isLoadingYtDlpFormats;

        if (isModalLocked) {
            return;
        }

        await addMediaForm.resetForm();

        setAddMediaOpen(false);
    }, [
        addMediaForm,
        isAddingMedia,
        isCancellingYtDlp,
        ytDlpEvents.isYtDlpRunning,
    ]);

    useEffect(() => {
        const previousSelectedChannelId = previousSelectedChannelIdRef.current;

        if (previousSelectedChannelId !== selectedChannelId) {
            previousSelectedChannelIdRef.current = selectedChannelId;

            if (addMediaOpen) {
                void addMediaForm.resetForm();

                setAddMediaOpen(false);
            }

            ytDlpEvents.resetYtDlpState(true);
            resetCancellingYtDlp();
        }
    }, [addMediaForm, addMediaOpen, resetCancellingYtDlp, selectedChannelId, ytDlpEvents]);

    useEffect(() => {
        if (addMediaOpen && !wasAddMediaOpenRef.current) {
            void addMediaForm.resetForm();
        }

        if (!addMediaOpen && wasAddMediaOpenRef.current) {
            ytDlpEvents.resetYtDlpState(true);
            resetCancellingYtDlp();
        }

        wasAddMediaOpenRef.current = addMediaOpen;
    }, [addMediaForm, addMediaOpen, resetCancellingYtDlp, ytDlpEvents]);

    return {
        addMediaOpen,
        setAddMediaOpen,
        isAddingMedia,
        isCancellingYtDlp,
        ytDlpLogs: ytDlpEvents.ytDlpLogs,
        isYtDlpRunning: ytDlpEvents.isYtDlpRunning,
        addMediaForm,
        addMedia,
        cancelYtDlpDownload,
        closeAddMediaModal,
    };
}