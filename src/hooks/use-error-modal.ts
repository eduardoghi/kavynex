import { useCallback, useRef, useState } from "react";
import type { ErrorModalVariant } from "../components/modals/error-modal";
import { useMemoObject } from "./use-memo-object";

export type ErrorModalController = {
    errorOpen: boolean;
    errorMessage: string;
    errorVariant: ErrorModalVariant;
    // Messages waiting behind the one on screen.
    pendingMessageCount: number;
    showError: (message: string) => void;
    showNotice: (message: string) => void;
    closeErrorModal: () => void;
};

type QueuedMessage = {
    message: string;
    variant: ErrorModalVariant;
};

// Bounds what a failure repeating in a loop can pile up. Past it the newest messages are dropped,
// since the ones already queued are the first failures and usually the cause of the rest.
const MAX_QUEUED_MESSAGES = 20;

function enqueue(queue: QueuedMessage[], next: QueuedMessage): QueuedMessage[] {
    // The same message twice says nothing new, and a retry that fails the same way would otherwise
    // make the user close it once per attempt.
    const alreadyQueued = queue.some(
        (entry) => entry.message === next.message && entry.variant === next.variant,
    );

    if (alreadyQueued || queue.length >= MAX_QUEUED_MESSAGES) {
        return queue;
    }

    return [...queue, next];
}

/**
 * Error and notice messages for the shared modal, shown one at a time in arrival order.
 *
 * A message never replaces the one on screen. A notice landing while an error is open used to
 * overwrite it, and the user never saw the failure. Closing shows the next one.
 */
export function useErrorModal(): ErrorModalController {
    const [queue, setQueue] = useState<QueuedMessage[]>([]);

    const showError = useCallback((message: string): void => {
        setQueue((current) => enqueue(current, { message, variant: "error" }));
    }, []);

    // Neutral, non-alarming message (e.g. "no comments were found"). Shown in the same modal
    // as errors but styled as a notice, so an expected outcome is not dressed up as a failure.
    const showNotice = useCallback((message: string): void => {
        setQueue((current) => enqueue(current, { message, variant: "notice" }));
    }, []);

    const closeErrorModal = useCallback((): void => {
        setQueue((current) => current.slice(1));
    }, []);

    const shown = queue[0];

    // What the modal keeps showing while it fades out after the last message was closed. Cleared
    // with the queue, the body went blank during the closing transition.
    const lastShown = useRef<QueuedMessage>({ message: "", variant: "error" });

    if (shown) {
        lastShown.current = shown;
    }

    const displayed = shown ?? lastShown.current;

    // Memoized so consumers depending on the whole object identity don't re-render unnecessarily.
    return useMemoObject({
        errorOpen: shown !== undefined,
        errorMessage: displayed.message,
        errorVariant: displayed.variant,
        pendingMessageCount: Math.max(queue.length - 1, 0),
        showError,
        showNotice,
        closeErrorModal,
    });
}
