import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ImportMode } from "../types/settings";
import { cancelMediaDownload, createMedia } from "../services";
import { useAddMediaForm } from "./use-add-media-form";
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

type WorkflowState = {
    addMediaOpen: boolean;
    isAddingMedia: boolean;
    isCancellingYtDlp: boolean;
};

type WorkflowAction =
    | { type: "SET_ADD_MEDIA_OPEN"; payload: boolean }
    | { type: "START_ADDING_MEDIA" }
    | { type: "FINISH_ADDING_MEDIA" }
    | { type: "START_CANCELLING_YT_DLP" }
    | { type: "FINISH_CANCELLING_YT_DLP" }
    | { type: "RESET_CANCELLING_YT_DLP" };

const INITIAL_STATE: WorkflowState = {
    addMediaOpen: false,
    isAddingMedia: false,
    isCancellingYtDlp: false,
};

function workflowReducer(state: WorkflowState, action: WorkflowAction): WorkflowState {
    switch (action.type) {
        case "SET_ADD_MEDIA_OPEN":
            return {
                ...state,
                addMediaOpen: action.payload,
            };

        case "START_ADDING_MEDIA":
            return {
                ...state,
                isAddingMedia: true,
            };

        case "FINISH_ADDING_MEDIA":
            return {
                ...state,
                isAddingMedia: false,
            };

        case "START_CANCELLING_YT_DLP":
            return {
                ...state,
                isCancellingYtDlp: true,
            };

        case "FINISH_CANCELLING_YT_DLP":
        case "RESET_CANCELLING_YT_DLP":
            return {
                ...state,
                isCancellingYtDlp: false,
            };

        default:
            return state;
    }
}

export function useAddMediaWorkflow({
    selectedChannelId,
    importMode,
    libraryPath,
    onError,
    onReloadMedia,
}: UseAddMediaWorkflowOptions): UseAddMediaWorkflowReturn {
    const [state, dispatch] = useReducer(workflowReducer, INITIAL_STATE);

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

    const setAddMediaOpen = useCallback(
        (value: React.SetStateAction<boolean>): void => {
            const resolvedValue =
                typeof value === "function" ? value(state.addMediaOpen) : value;

            dispatch({
                type: "SET_ADD_MEDIA_OPEN",
                payload: resolvedValue,
            });
        },
        [state.addMediaOpen]
    );

    const addMedia = useCallback(async (): Promise<void> => {
        if (selectedChannelId === null) {
            onError("Select a channel before adding media.");
            return;
        }

        const isPreparingMedia =
            addMediaForm.isGeneratingThumb || addMediaForm.isLoadingYtDlpFormats;

        if (
            state.isAddingMedia ||
            state.isCancellingYtDlp ||
            isPreparingMedia ||
            ytDlpEvents.isYtDlpRunning
        ) {
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

        dispatch({ type: "START_ADDING_MEDIA" });

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

            dispatch({
                type: "SET_ADD_MEDIA_OPEN",
                payload: false,
            });
        } catch (error) {
            ytDlpEvents.markStopped();

            logError("add-media", "Failed to add media.", error, {
                selectedChannelId,
                sourceMode: addMediaForm.sourceMode,
                libraryPath,
                cookiesBrowser: addMediaForm.cookiesBrowser,
            });
            onError(resolveErrorMessage(error, "Failed to add media."));
        } finally {
            dispatch({ type: "FINISH_ADDING_MEDIA" });
        }
    }, [
        addMediaForm,
        importMode,
        libraryPath,
        onError,
        onReloadMedia,
        selectedChannelId,
        state.isAddingMedia,
        state.isCancellingYtDlp,
        ytDlpEvents,
    ]);

    const cancelYtDlpDownload = useCallback(async (): Promise<void> => {
        const runId = ytDlpEvents.currentRunIdRef.current.trim();

        if (!runId || !ytDlpEvents.isYtDlpRunning || state.isCancellingYtDlp) {
            return;
        }

        dispatch({ type: "START_CANCELLING_YT_DLP" });

        try {
            await cancelMediaDownload(runId);
        } catch (error) {
            logError("add-media", "Failed to cancel media download.", error, {
                runId,
            });
            onError(resolveErrorMessage(error, "Failed to cancel media download."));
        } finally {
            dispatch({ type: "FINISH_CANCELLING_YT_DLP" });
        }
    }, [onError, state.isCancellingYtDlp, ytDlpEvents]);

    const closeAddMediaModal = useCallback(async (): Promise<void> => {
        const isModalLocked =
            state.isAddingMedia ||
            ytDlpEvents.isYtDlpRunning ||
            state.isCancellingYtDlp ||
            addMediaForm.isGeneratingThumb ||
            addMediaForm.isLoadingYtDlpFormats;

        if (isModalLocked) {
            return;
        }

        await addMediaForm.resetForm();

        dispatch({
            type: "SET_ADD_MEDIA_OPEN",
            payload: false,
        });
    }, [
        addMediaForm,
        state.isAddingMedia,
        state.isCancellingYtDlp,
        ytDlpEvents.isYtDlpRunning,
    ]);

    useEffect(() => {
        const previousSelectedChannelId = previousSelectedChannelIdRef.current;

        if (previousSelectedChannelId !== selectedChannelId) {
            previousSelectedChannelIdRef.current = selectedChannelId;

            if (state.addMediaOpen) {
                void addMediaForm.resetForm();

                dispatch({
                    type: "SET_ADD_MEDIA_OPEN",
                    payload: false,
                });
            }

            ytDlpEvents.resetYtDlpState(true);
            dispatch({ type: "RESET_CANCELLING_YT_DLP" });
        }
    }, [addMediaForm, selectedChannelId, state.addMediaOpen, ytDlpEvents]);

    useEffect(() => {
        if (state.addMediaOpen && !wasAddMediaOpenRef.current) {
            void addMediaForm.resetForm();
        }

        if (!state.addMediaOpen && wasAddMediaOpenRef.current) {
            ytDlpEvents.resetYtDlpState(true);
            dispatch({ type: "RESET_CANCELLING_YT_DLP" });
        }

        wasAddMediaOpenRef.current = state.addMediaOpen;
    }, [addMediaForm, state.addMediaOpen, ytDlpEvents]);

    return {
        addMediaOpen: state.addMediaOpen,
        setAddMediaOpen,
        isAddingMedia: state.isAddingMedia,
        isCancellingYtDlp: state.isCancellingYtDlp,
        ytDlpLogs: ytDlpEvents.ytDlpLogs,
        isYtDlpRunning: ytDlpEvents.isYtDlpRunning,
        addMediaForm,
        addMedia,
        cancelYtDlpDownload,
        closeAddMediaModal,
    };
}