import { useCallback, useRef, useState } from "react";

type UsePerIdAsyncFlagReturn = {
    /** The ids currently in flight. Empty when nothing is running. */
    inFlight: ReadonlySet<number>;
    /** True while any id is in flight, for a control that is not tied to a single row. */
    isRunning: boolean;
    /** Runs `task` unless `id` is already in flight, in which case it is a no-op. */
    runFor: (id: number, task: () => Promise<void>) => Promise<void>;
};

/**
 * A re-entrancy guard keyed by id, for an action that can be started independently on several
 * rows.
 *
 * The counterpart of `useAsyncFlag`, which guards with one shared boolean. That is the right shape
 * for something there is only ever one of (the Add Media submit), and the wrong one here: its
 * `runWithFlag` returns undefined without throwing when it is already running, so a second call
 * simply vanishes. When the action belongs to a *row*, that turns "act on A, then act on B" into a
 * silent no-op for B, which the user cannot tell apart from it having worked.
 *
 * Keying by id keeps the guard where it belongs - the same row cannot be acted on twice at once -
 * while leaving independent rows independent.
 */
export function usePerIdAsyncFlag(): UsePerIdAsyncFlagReturn {
    // The ref is what the guard reads: state alone would let two calls in the same tick both see
    // the pre-update value and get through. The state exists only so a component can render the
    // busy set.
    const inFlightRef = useRef<Set<number>>(new Set());
    const [inFlight, setInFlight] = useState<ReadonlySet<number>>(new Set());

    const runFor = useCallback(async (id: number, task: () => Promise<void>): Promise<void> => {
        if (inFlightRef.current.has(id)) {
            return;
        }

        inFlightRef.current.add(id);
        setInFlight(new Set(inFlightRef.current));

        try {
            await task();
        } finally {
            inFlightRef.current.delete(id);
            setInFlight(new Set(inFlightRef.current));
        }
    }, []);

    return {
        inFlight,
        isRunning: inFlight.size > 0,
        runFor,
    };
}
