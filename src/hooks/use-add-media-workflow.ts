import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportMode } from "../types/settings";
import { cancelMediaDownload, createMedia } from "../services";
import { useAddMediaForm } from "./use-add-media-form";
import { useAsyncFlag } from "./use-async-flag";
import { useYtDlpEvents, type YtDlpLogLine } from "./use-yt-dlp-events";
import { resolveErrorMessage } from "../utils/error-message";
import { parseAppError } from "../utils/app-error";
import { YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE } from "../constants/error-codes";
import { logError } from "../utils/app-logger";
import { useMemoObject } from "./use-memo-object";
import {
    buildCreateMediaInput,
    buildYtDlpCommandPreview,
    generateYtDlpRunId,
    resolveCookiesSource,
    validateAddMediaForm,
} from "../use-cases/add-media";

type UseAddMediaWorkflowOptions = {
    selectedChannelId: number | null;
    importMode: ImportMode;
    libraryPath: string;
    onError: (message: string) => void;
    // A cancelled download is a result the user asked for, not a failure, so it needs the neutral
    // channel rather than the error modal (the same split useMediaActions makes for "no comments
    // were found").
    onNotice: (message: string) => void;
    // Reloads the current channel's media list. Takes no channel argument on purpose: the wired
    // implementation (useChannelMediaList.reloadMedia) always reloads the currently selected
    // channel from its own ref, so a passed id would be silently ignored.
    onReloadMedia: () => Promise<void>;
};

type UseAddMediaWorkflowReturn = {
    addMediaOpen: boolean;
    setAddMediaOpen: React.Dispatch<React.SetStateAction<boolean>>;
    isAddingMedia: boolean;
    isCancellingYtDlp: boolean;
    ytDlpLogs: YtDlpLogLine[];
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
    onNotice,
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

    // Destructure the stable fields off the per-render addMediaForm/ytDlpEvents controller
    // objects so the callbacks and effects below can depend on them directly. This keeps the
    // dependency arrays honest (no eslint-disable) while still not depending on the whole
    // objects, whose identity changes every render. isGeneratingThumb, isLoadingYtDlpFormats,
    // and isYtDlpRunning are deliberately NOT destructured here: closeAddMediaModal below must
    // read them live off addMediaForm/ytDlpEvents at call time rather than from a snapshot
    // captured at the last render (see the "does not close the modal while ..." tests, which
    // flip these flags on the mocked controllers without triggering a re-render in between).
    const { resetForm } = addMediaForm;
    // startRun/appendManualLog/markStopped are stable (useCallback in useYtDlpEvents), so addMedia
    // can depend on them directly instead of on the whole ytDlpEvents object - whose identity
    // changes on every log line (ytDlpLogs is part of it), which was churning addMedia's identity
    // on each stdout line during an active download.
    const { ytDlpLogs, isYtDlpRunning, resetYtDlpState, startRun, appendManualLog, markStopped } =
        ytDlpEvents;

    // addMedia reads the form's field values only when the user clicks add, never during render, so
    // mirror the per-render form controller into a ref and read it live inside the callback. That
    // keeps addMedia from depending on addMediaForm - a fresh object every render - which was
    // recreating the callback (and, through the memoized controller it feeds, its consumers) on
    // every keystroke. Same "read the latest value off a ref" pattern as activeMediaRef in
    // use-media-actions.ts (see CONTRIBUTING.md's hook conventions).
    const addMediaFormRef = useRef(addMediaForm);
    useEffect(() => {
        addMediaFormRef.current = addMediaForm;
    }, [addMediaForm]);

    const addMedia = useCallback(async (): Promise<void> => {
        const form = addMediaFormRef.current;

        const validation = validateAddMediaForm(form, selectedChannelId, {
            isCancellingYtDlp,
            isYtDlpRunning,
        });

        if (validation.status === "skip") {
            return;
        }

        if (validation.status === "error") {
            onError(validation.message);
            return;
        }

        // validation.status === "ok" only when selectedChannelId is non-null; re-check to narrow
        // the type for TypeScript.
        if (selectedChannelId === null) {
            return;
        }

        const { sourceMode, sourceValue } = validation;

        await runAddMedia(async () => {
            try {
                const { cookiesBrowser, cookiesPath } = resolveCookiesSource(
                    form.cookiesBrowser,
                    form.cookiesPath
                );

                let ytDlpRunId = "";
                let ytDlpFormatId = "";

                if (sourceMode === "yt-dlp") {
                    ytDlpRunId = generateYtDlpRunId();
                    ytDlpFormatId = form.selectedYtDlpFormatId.trim();

                    startRun(
                        ytDlpRunId,
                        buildYtDlpCommandPreview(
                            form.mediaUrl,
                            cookiesBrowser,
                            cookiesPath,
                            ytDlpFormatId
                        )
                    );

                    appendManualLog(
                        form.downloadComments
                            ? "Comments: enabled"
                            : "Comments: disabled"
                    );

                    appendManualLog(
                        form.downloadLiveChat
                            ? "Live chat: enabled"
                            : "Live chat: disabled"
                    );

                    if (cookiesPath) {
                        appendManualLog("Cookies: manual .txt file");
                    } else if (cookiesBrowser) {
                        appendManualLog(`Cookies from browser: ${cookiesBrowser}`);
                    }
                }

                await createMedia(
                    buildCreateMediaInput(form, {
                        channelId: selectedChannelId,
                        sourceMode,
                        sourceValue,
                        importMode,
                        libraryPath,
                        ytDlpRunId,
                        ytDlpFormatId,
                        cookiesBrowser,
                        cookiesPath,
                    }),
                    {
                        onProgress: (message) => {
                            appendManualLog(message);
                        },
                    }
                );

                await onReloadMedia();
                await form.resetForm();

                setAddMediaOpen(false);
            } catch (error) {
                markStopped();

                // A cancelled download travels as an error because that is how the backend unwinds
                // it, but it is the outcome the user clicked for: the run stopped and nothing was
                // left behind. Reporting it through the error modal told them something went wrong
                // when the thing they asked for is exactly what happened.
                if (parseAppError(error).code === YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE) {
                    onNotice("Download cancelled. Nothing was added to your library.");
                    return;
                }

                logError("add-media", "Failed to add media.", error, {
                    selectedChannelId,
                    sourceMode: form.sourceMode,
                    libraryPath,
                    cookiesBrowser: form.cookiesBrowser,
                });
                onError(resolveErrorMessage(error, "Failed to add media."));
            }
        });
    }, [
        appendManualLog,
        importMode,
        isCancellingYtDlp,
        isYtDlpRunning,
        libraryPath,
        markStopped,
        onError,
        onNotice,
        onReloadMedia,
        runAddMedia,
        selectedChannelId,
        startRun,
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
    }, [onError, runCancelYtDlp, ytDlpEvents.currentRunIdRef, ytDlpEvents.isYtDlpRunning]);

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

        await resetForm();

        setAddMediaOpen(false);
        // Note: isGeneratingThumb/isLoadingYtDlpFormats/isYtDlpRunning are deliberately read
        // live off addMediaForm/ytDlpEvents below (not destructured) - this guard has to see a
        // flag flip that can happen without a re-render in between; see the comment above the
        // addMediaForm/ytDlpEvents destructuring further up.
    }, [
        addMediaForm.isGeneratingThumb,
        addMediaForm.isLoadingYtDlpFormats,
        resetForm,
        isAddingMedia,
        isCancellingYtDlp,
        ytDlpEvents.isYtDlpRunning,
    ]);

    useEffect(() => {
        const previousSelectedChannelId = previousSelectedChannelIdRef.current;

        if (previousSelectedChannelId !== selectedChannelId) {
            previousSelectedChannelIdRef.current = selectedChannelId;

            if (addMediaOpen) {
                void resetForm();

                setAddMediaOpen(false);
            }

            resetYtDlpState(true);
            resetCancellingYtDlp();
        }
    }, [
        resetForm,
        addMediaOpen,
        resetCancellingYtDlp,
        selectedChannelId,
        resetYtDlpState,
    ]);

    useEffect(() => {
        if (addMediaOpen && !wasAddMediaOpenRef.current) {
            void resetForm();
        }

        if (!addMediaOpen && wasAddMediaOpenRef.current) {
            resetYtDlpState(true);
            resetCancellingYtDlp();
        }

        wasAddMediaOpenRef.current = addMediaOpen;
    }, [resetForm, addMediaOpen, resetCancellingYtDlp, resetYtDlpState]);

    return useMemoObject({
        addMediaOpen,
        setAddMediaOpen,
        isAddingMedia,
        isCancellingYtDlp,
        ytDlpLogs,
        isYtDlpRunning,
        addMediaForm,
        addMedia,
        cancelYtDlpDownload,
        closeAddMediaModal,
    });
}