import { useCallback, useEffect, useRef, useState } from "react";
import {
    deleteTemporaryThumbnail,
    generateTemporaryThumbnail,
} from "../services/thumbnail-service";
import { logError } from "../utils/app-logger";
import { useMemoObject } from "./use-memo-object";
import { useRequestGuard } from "./use-request-guard";

type UseTempThumbnailReturn = {
    thumbPath: string;
    isGeneratingThumb: boolean;
    setManualThumbPath: (nextPath: string, tracksTempFile: boolean) => Promise<void>;
    generateThumbForMedia: (path: string) => Promise<void>;
    resetThumbState: () => Promise<void>;
};

export function useTempThumbnail(): UseTempThumbnailReturn {
    const [thumbPath, setThumbPath] = useState("");
    const [isGeneratingThumb, setIsGeneratingThumb] = useState(false);

    // Guards against a stale async result overwriting a newer one. Every generate begins a new
    // request and every reset invalidates the in-flight one, and a settled request only applies its
    // result when its id is still current. This is what makes a setState after unmount harmless too.
    // React 18+ dropped the unmounted-setState warning and treats the call as a no-op, so no
    // mount-tracking ref is needed on top of the id check.
    const thumbGenerationGuard = useRequestGuard();
    const currentTempThumbRef = useRef("");

    const cleanupTempThumb = useCallback(async (path?: string | null): Promise<void> => {
        const normalizedPath = path?.trim() ?? "";

        if (!normalizedPath) {
            return;
        }

        try {
            await deleteTemporaryThumbnail(normalizedPath);
        } catch (error) {
            logError("temp-thumbnail", "Failed to clean up the temporary thumbnail.", error);
        }

        if (currentTempThumbRef.current === normalizedPath) {
            currentTempThumbRef.current = "";
        }
    }, []);

    useEffect(() => {
        return () => {
            const currentTempThumb = currentTempThumbRef.current.trim();

            if (currentTempThumb) {
                void cleanupTempThumb(currentTempThumb);
            }
        };
    }, [cleanupTempThumb]);

    const replaceGeneratedTempThumb = useCallback(
        async (nextPath: string): Promise<void> => {
            const normalizedNextPath = nextPath.trim();
            const previousPath = currentTempThumbRef.current.trim();

            if (previousPath && previousPath !== normalizedNextPath) {
                await cleanupTempThumb(previousPath);
            }

            currentTempThumbRef.current = normalizedNextPath;
            setThumbPath(normalizedNextPath);
        },
        [cleanupTempThumb]
    );

    // `tracksTempFile` says whether `nextPath` is a file this app wrote into the preview directory
    // and is therefore ours to delete. A manually picked thumbnail is staged there (so it can be
    // previewed without widening the asset scope to the user's own file), which makes it a temp file
    // with the same lifecycle as a generated one; if that staging failed the caller falls back to
    // the path the user picked, which is *not* ours and must never be handed to the delete command.
    const setManualThumbPath = useCallback(
        async (nextPath: string, tracksTempFile: boolean): Promise<void> => {
            const normalizedNextPath = nextPath.trim();
            const previousTempPath = currentTempThumbRef.current.trim();

            thumbGenerationGuard.invalidate();
            setIsGeneratingThumb(false);

            if (previousTempPath && previousTempPath !== normalizedNextPath) {
                await cleanupTempThumb(previousTempPath);
            }

            currentTempThumbRef.current = tracksTempFile ? normalizedNextPath : "";
            setThumbPath(normalizedNextPath);
        },
        [cleanupTempThumb, thumbGenerationGuard]
    );

    const generateThumbForMedia = useCallback(
        async (path: string): Promise<void> => {
            const normalizedPath = path.trim();

            if (!normalizedPath) {
                return;
            }

            const requestId = thumbGenerationGuard.begin();
            setIsGeneratingThumb(true);

            try {
                const generatedPath = await generateTemporaryThumbnail(normalizedPath);

                if (!thumbGenerationGuard.isCurrent(requestId)) {
                    await cleanupTempThumb(generatedPath);
                    return;
                }

                await replaceGeneratedTempThumb(generatedPath);
            } catch (error) {
                logError("temp-thumbnail", "Failed to generate the temporary thumbnail.", error);

                if (thumbGenerationGuard.isCurrent(requestId)) {
                    const currentTempThumb = currentTempThumbRef.current.trim();

                    if (currentTempThumb) {
                        await cleanupTempThumb(currentTempThumb);
                    }

                    currentTempThumbRef.current = "";
                    setThumbPath("");
                }
            } finally {
                if (thumbGenerationGuard.isCurrent(requestId)) {
                    setIsGeneratingThumb(false);
                }
            }
        },
        [cleanupTempThumb, replaceGeneratedTempThumb, thumbGenerationGuard]
    );

    const resetThumbState = useCallback(async (): Promise<void> => {
        thumbGenerationGuard.invalidate();
        setIsGeneratingThumb(false);
        setThumbPath("");

        const currentTempThumb = currentTempThumbRef.current;
        currentTempThumbRef.current = "";

        if (currentTempThumb) {
            await cleanupTempThumb(currentTempThumb);
        }
    }, [cleanupTempThumb, thumbGenerationGuard]);

    // Memoized so this hook's return keeps a stable identity across renders. Its consumer
    // (use-add-media-form) lists the whole object as a useCallback dependency, so an unstable
    // identity here would recreate those callbacks (and the memoized form controller built from
    // them), on every render (e.g. every streamed yt-dlp log line), defeating the memoization.
    return useMemoObject({
        thumbPath,
        isGeneratingThumb,
        setManualThumbPath,
        generateThumbForMedia,
        resetThumbState,
    });
}
