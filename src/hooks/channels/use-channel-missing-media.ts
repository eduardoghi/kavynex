import { useCallback, useEffect, useRef, useState } from "react";
import {
    cancelMediaDownload,
    listChannelMissingMedia,
} from "../../services/media-download-service";
import type { MissingChannelMedia } from "../../types/generated/MissingChannelMedia";
import type { ChannelMediaOnYoutube } from "../../types/generated/ChannelMediaOnYoutube";
import { setChannelMediaIgnored } from "../../services/channel-service";
import { YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE } from "../../constants/error-codes";
import { generateYtDlpRunId } from "../../use-cases/add-media";
import { parseAppError } from "../../utils/app-error";
import { logError } from "../../utils/app-logger";
import { resolveErrorMessage } from "../../utils/error-message";
import { useMemoObject } from "../use-memo-object";
import { useRequestGuard } from "../use-request-guard";

export type ChannelMissingMediaController = {
    // The last listing, or null before the first one finishes.
    result: MissingChannelMedia | null;
    isLoading: boolean;
    // Why the last listing failed, or null.
    error: string | null;
    // The media opened for import from this listing, for the list to mark.
    openedIds: ReadonlySet<string>;
    // Why the last ignore or "show again" could not be saved, or null.
    ignoreError: string | null;
    // Moves a media to the ignored list, or back. Shown at once, and put back if it cannot be saved.
    setIgnored: (media: ChannelMediaOnYoutube, ignored: boolean) => Promise<void>;
    // Lists the channel on YouTube again. A listing still running is stopped first.
    check: () => Promise<void>;
    cancel: () => void;
    markOpened: (youtubeVideoId: string) => void;
};

// Newest first and undated last, the order the backend lists them in, so a media moved between the
// two lists lands where a new listing would put it.
function inListingOrder(media: ChannelMediaOnYoutube[]): ChannelMediaOnYoutube[] {
    return [...media].sort((a, b) => (b.published_at ?? -Infinity) - (a.published_at ?? -Infinity));
}

// Moves `media` into the ignored list (or out of it) of `listing`.
function withIgnored(
    listing: MissingChannelMedia,
    media: ChannelMediaOnYoutube,
    ignored: boolean
): MissingChannelMedia {
    const id = media.youtube_video_id;
    const missing = listing.missing.filter((item) => item.youtube_video_id !== id);
    const ignoredList = listing.ignored.filter((item) => item.youtube_video_id !== id);

    return ignored
        ? { ...listing, missing, ignored: inListingOrder([...ignoredList, media]) }
        : { ...listing, missing: inListingOrder([...missing, media]), ignored: ignoredList };
}

// The media a channel has on YouTube that its library does not (see `list_channel_missing_media`).
// Listed on demand, since a channel changes on YouTube and a large one takes a few seconds to list,
// and kept for as long as the channel page is, so reopening the list does not ask YouTube again.
export function useChannelMissingMedia(channelId: number): ChannelMissingMediaController {
    const [result, setResult] = useState<MissingChannelMedia | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [openedIds, setOpenedIds] = useState<ReadonlySet<string>>(new Set());
    const [ignoreError, setIgnoreError] = useState<string | null>(null);
    const requestGuard = useRequestGuard();
    // The run id of the listing in flight, which a cancel stops by name.
    const runIdRef = useRef<string | null>(null);

    const stopRunning = useCallback((): void => {
        const runId = runIdRef.current;
        runIdRef.current = null;

        if (runId) {
            void cancelMediaDownload(runId).catch(() => undefined);
        }
    }, []);

    const check = useCallback(async (): Promise<void> => {
        stopRunning();

        const requestId = requestGuard.begin();
        const runId = `channel-listing-${generateYtDlpRunId()}`;
        runIdRef.current = runId;
        setIsLoading(true);
        setError(null);

        try {
            const listed = await listChannelMissingMedia(channelId, runId);

            if (!requestGuard.isCurrent(requestId)) {
                return;
            }

            setResult(listed);
            setOpenedIds(new Set());
        } catch (failure) {
            if (!requestGuard.isCurrent(requestId)) {
                return;
            }

            // Stopped on purpose, so neither an error to show nor one to log.
            if (parseAppError(failure).code === YT_DLP_DOWNLOAD_CANCELLED_ERROR_CODE) {
                return;
            }

            logError("channels", "Failed to list the channel's media on YouTube.", failure, {
                channelId,
            });
            setError(resolveErrorMessage(failure, "Could not list the channel's media on YouTube."));
        } finally {
            if (requestGuard.isCurrent(requestId)) {
                runIdRef.current = null;
                setIsLoading(false);
            }
        }
    }, [channelId, requestGuard, stopRunning]);

    const cancel = useCallback((): void => {
        requestGuard.invalidate();
        stopRunning();
        setIsLoading(false);
    }, [requestGuard, stopRunning]);

    const setIgnored = useCallback(
        async (media: ChannelMediaOnYoutube, ignored: boolean): Promise<void> => {
            setIgnoreError(null);
            setResult((current) => (current ? withIgnored(current, media, ignored) : current));

            try {
                await setChannelMediaIgnored(channelId, media.youtube_video_id, ignored);
            } catch (failure) {
                setResult((current) => (current ? withIgnored(current, media, !ignored) : current));
                logError("channels", "Failed to save an ignored channel media.", failure, {
                    channelId,
                    youtubeVideoId: media.youtube_video_id,
                    ignored,
                });
                setIgnoreError(
                    resolveErrorMessage(
                        failure,
                        ignored
                            ? "The media could not be ignored."
                            : "The media could not be shown again."
                    )
                );
            }
        },
        [channelId]
    );

    const markOpened = useCallback((youtubeVideoId: string): void => {
        setOpenedIds((current) => new Set(current).add(youtubeVideoId));
    }, []);

    // A listing still running when the channel page goes is stopped rather than left to finish for
    // nobody.
    useEffect(() => stopRunning, [stopRunning]);

    return useMemoObject({
        result,
        isLoading,
        error,
        openedIds,
        ignoreError,
        check,
        cancel,
        markOpened,
        setIgnored,
    });
}
