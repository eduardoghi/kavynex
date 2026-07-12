import { useCallback, useEffect, useRef, useState } from "react";
import {
    deleteTemporaryThumbnail,
    generateTemporaryThumbnail,
} from "../services/thumbnail-service";
import { logError } from "../utils/app-logger";

type UseTempThumbnailReturn = {
    thumbPath: string;
    isGeneratingThumb: boolean;
    setManualThumbPath: (nextPath: string) => Promise<void>;
    generateThumbForMedia: (path: string) => Promise<void>;
    resetThumbState: () => Promise<void>;
};

export function useTempThumbnail(): UseTempThumbnailReturn {
    const [thumbPath, setThumbPath] = useState("");
    const [isGeneratingThumb, setIsGeneratingThumb] = useState(false);

    const thumbGenerationIdRef = useRef(0);
    const currentTempThumbRef = useRef("");
    const isMountedRef = useRef(true);

    useEffect(() => {
        isMountedRef.current = true;

        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const safeSetThumbPath = useCallback((value: string): void => {
        if (!isMountedRef.current) {
            return;
        }

        setThumbPath(value);
    }, []);

    const safeSetIsGeneratingThumb = useCallback((value: boolean): void => {
        if (!isMountedRef.current) {
            return;
        }

        setIsGeneratingThumb(value);
    }, []);

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
            safeSetThumbPath(normalizedNextPath);
        },
        [cleanupTempThumb, safeSetThumbPath]
    );

    const setManualThumbPath = useCallback(
        async (nextPath: string): Promise<void> => {
            const normalizedNextPath = nextPath.trim();
            const previousTempPath = currentTempThumbRef.current.trim();

            thumbGenerationIdRef.current += 1;
            safeSetIsGeneratingThumb(false);

            if (previousTempPath) {
                await cleanupTempThumb(previousTempPath);
            }

            currentTempThumbRef.current = "";
            safeSetThumbPath(normalizedNextPath);
        },
        [cleanupTempThumb, safeSetIsGeneratingThumb, safeSetThumbPath]
    );

    const generateThumbForMedia = useCallback(
        async (path: string): Promise<void> => {
            const normalizedPath = path.trim();

            if (!normalizedPath) {
                return;
            }

            const requestId = ++thumbGenerationIdRef.current;
            safeSetIsGeneratingThumb(true);

            try {
                const generatedPath = await generateTemporaryThumbnail(normalizedPath);

                if (requestId !== thumbGenerationIdRef.current) {
                    await cleanupTempThumb(generatedPath);
                    return;
                }

                await replaceGeneratedTempThumb(generatedPath);
            } catch (error) {
                logError("temp-thumbnail", "Failed to generate the temporary thumbnail.", error);

                if (requestId === thumbGenerationIdRef.current) {
                    const currentTempThumb = currentTempThumbRef.current.trim();

                    if (currentTempThumb) {
                        await cleanupTempThumb(currentTempThumb);
                    }

                    currentTempThumbRef.current = "";
                    safeSetThumbPath("");
                }
            } finally {
                if (requestId === thumbGenerationIdRef.current) {
                    safeSetIsGeneratingThumb(false);
                }
            }
        },
        [
            cleanupTempThumb,
            replaceGeneratedTempThumb,
            safeSetIsGeneratingThumb,
            safeSetThumbPath,
        ]
    );

    const resetThumbState = useCallback(async (): Promise<void> => {
        thumbGenerationIdRef.current += 1;
        safeSetIsGeneratingThumb(false);
        safeSetThumbPath("");

        const currentTempThumb = currentTempThumbRef.current;
        currentTempThumbRef.current = "";

        if (currentTempThumb) {
            await cleanupTempThumb(currentTempThumb);
        }
    }, [cleanupTempThumb, safeSetIsGeneratingThumb, safeSetThumbPath]);

    return {
        thumbPath,
        isGeneratingThumb,
        setManualThumbPath,
        generateThumbForMedia,
        resetThumbState,
    };
}