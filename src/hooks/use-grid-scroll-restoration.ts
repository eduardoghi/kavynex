import { useCallback, useEffect, useRef, type RefObject, type UIEventHandler } from "react";

type UseGridScrollRestorationResult = {
    // Attach to the scrollable grid container (and hand to the virtualizer's getScrollElement).
    scrollParentRef: RefObject<HTMLDivElement | null>;
    // Attach to that same container's onScroll.
    onScroll: UIEventHandler<HTMLDivElement>;
};

// Preserves and restores the media grid's scroll position across visibility toggles. The grid is
// hidden (not unmounted) while the player is open so its scroll position survives; this hook saves
// the position when it hides and restores it when it shows again. The restore is deferred to two
// animation frames so the virtualizer has laid out its rows before the scrollTop is reapplied, and
// the `isRestoringScroll` guard keeps that programmatic scroll from being mistaken for a real user
// scroll and overwriting the saved value. Extracted from MediaGrid so this fragile, ref-heavy
// bookkeeping lives apart from the grid's focus-highlight and virtualizer-measure concerns, which
// it previously sat interleaved with.
export function useGridScrollRestoration(isVisible: boolean): UseGridScrollRestorationResult {
    const scrollParentRef = useRef<HTMLDivElement | null>(null);
    const savedScrollTopRef = useRef(0);
    const wasVisibleRef = useRef(isVisible);
    const isRestoringScrollRef = useRef(false);
    const restoreFrameRef = useRef<number | null>(null);
    const restoreSecondFrameRef = useRef<number | null>(null);

    useEffect(() => {
        const scrollElement = scrollParentRef.current;

        if (!scrollElement) {
            wasVisibleRef.current = isVisible;
            return;
        }

        const wasVisible = wasVisibleRef.current;

        if (wasVisible && !isVisible) {
            savedScrollTopRef.current = scrollElement.scrollTop;
        }

        if (!wasVisible && isVisible) {
            const savedScrollTop = savedScrollTopRef.current;

            isRestoringScrollRef.current = true;

            if (restoreFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreFrameRef.current);
                restoreFrameRef.current = null;
            }

            if (restoreSecondFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreSecondFrameRef.current);
                restoreSecondFrameRef.current = null;
            }

            restoreFrameRef.current = window.requestAnimationFrame(() => {
                scrollElement.scrollTop = savedScrollTop;

                restoreSecondFrameRef.current = window.requestAnimationFrame(() => {
                    scrollElement.scrollTop = savedScrollTop;
                    isRestoringScrollRef.current = false;
                    restoreSecondFrameRef.current = null;
                });

                restoreFrameRef.current = null;
            });
        }

        wasVisibleRef.current = isVisible;

        return () => {
            if (restoreFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreFrameRef.current);
                restoreFrameRef.current = null;
            }

            if (restoreSecondFrameRef.current !== null) {
                window.cancelAnimationFrame(restoreSecondFrameRef.current);
                restoreSecondFrameRef.current = null;
            }

            isRestoringScrollRef.current = false;
        };
    }, [isVisible]);

    const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
        (event) => {
            // Ignore the programmatic restore scroll and any scroll while hidden, so neither
            // overwrites the position we are trying to preserve.
            if (isRestoringScrollRef.current || !isVisible) {
                return;
            }

            savedScrollTopRef.current = event.currentTarget.scrollTop;
        },
        [isVisible]
    );

    return { scrollParentRef, onScroll };
}
