import { useCallback, useMemo, useRef } from "react";

// A monotonically increasing request-id guard for "latest wins" async flows. Each `begin`
// supersedes any older in-flight request, so a slow or earlier response can check `isCurrent`
// and discard itself instead of clobbering the state of a newer request (e.g. a rapid library
// or channel switch must not leave the previous target's data on screen). `invalidate` bumps
// the id without starting a new request, so a reset/clear also discards anything in flight.
//
// It is a request-id guard, not a mutex: the newer call runs immediately; only the stale
// response is dropped.
export type RequestGuard = {
    begin: () => number;
    isCurrent: (requestId: number) => boolean;
    invalidate: () => void;
};

export function useRequestGuard(): RequestGuard {
    const latestRequestIdRef = useRef(0);

    const begin = useCallback((): number => {
        latestRequestIdRef.current += 1;
        return latestRequestIdRef.current;
    }, []);

    const isCurrent = useCallback(
        (requestId: number): boolean => requestId === latestRequestIdRef.current,
        []
    );

    const invalidate = useCallback((): void => {
        latestRequestIdRef.current += 1;
    }, []);

    // Stable identity (all three callbacks are stable) so a consumer can list the guard in a
    // dependency array without invalidating its own memoized callbacks every render.
    return useMemo(() => ({ begin, isCurrent, invalidate }), [begin, isCurrent, invalidate]);
}
