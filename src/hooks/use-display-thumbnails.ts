import { useEffect, useMemo, useRef, useState } from "react";
import { resolveDisplayThumbnails } from "../services/thumbnail-service";
import { logError } from "../utils/app-logger";

const EMPTY_DISPLAY_THUMBNAILS: ReadonlyMap<string, string> = new Map();

// Joins the requested paths into the effect's dependency key. A newline, not a space. A library
// path is app-written and content-addressed today (`thumbnails/thumb_<sha256>.jpg`), but the value
// comes out of the database, so a row written by an older build or arriving through an import can
// hold anything, and a space in one would split into two path fragments that resolve to nothing,
// which surfaces as a thumbnail that silently never gets a derivative. A newline cannot appear in a
// path on Windows and is not producible by any of this app's writers.
const REQUEST_KEY_SEPARATOR = "\n";

// How long to wait before re-asking after a request that settled nothing at all. Short enough that
// the grid catches up while the user is still looking at the page, long enough that a backend busy
// with another page has a real chance to finish and free the slot this is waiting on.
const DISPLAY_RETRY_DELAY_MS = 1500;

// How many times one request may be re-asked without settling anything before the hook gives up.
//
// The contention this recovers from clears in a round or two. The call holding the backend's resolve
// slot finishes and releases it. A request still making no progress after that is not contended, it
// is one the backend cannot answer. A machine where FFmpeg hangs, so every entry spends the call
// budget instead of producing a derivative. Re-asking *that* forever would leave a timer running for
// the rest of the session to re-derive the same answer, and the cost of stopping is one session of
// drawing the stored thumbnail, which is this hook's declared fallback.
const MAX_DISPLAY_RETRIES = 3;

/**
 * Resolves display-sized copies of the thumbnails a list of media points at, so the grid can draw a
 * smaller decode than the stored file.
 *
 * The map is keyed by the library-relative thumbnail path, which is what a card already holds, so
 * a consumer looks its own entry up without any per-card state or per-card IPC.
 *
 * Two properties make this safe to add to a hot path:
 *
 * - **It never gates a render.** The first paint uses the stored thumbnails exactly as before; the
 *   map arrives afterwards and cards swap to the derivative. Nothing waits on it, and a failure
 *   leaves the grid rendering what it rendered before this hook existed.
 * - **It never narrows.** Resolutions accumulate across pages rather than replacing each other, so
 *   scrolling a paginated channel does not drop the derivatives of the rows already on screen (which
 *   would swap them *back* to the large file mid-scroll). The accumulated map is dropped only when
 *   the library path changes, which is the one event that invalidates every path in it.
 *
 * Both of the costs that come with sitting on that path are bounded deliberately, and both bounds
 * are load-bearing at library scale rather than micro-optimizations:
 *
 * - **The dependency key is memoized on the (already stable) input array.** The grid re-renders on
 *   every scroll tick. That is what `useVirtualizer` does, and it passes every row loaded so far,
 *   not just the visible window. Rebuilding the key in the hook body therefore meant a map, a filter
 *   and a join over thousands of strings per frame, allocating a several-hundred-kilobyte string each
 *   time. That is a scroll-jank source that grows with the library, in the hook whose entire purpose
 *   is to make scrolling cheaper.
 * - **Only paths without a derivative yet are asked about.** Each request otherwise carried every
 *   loaded path, so appending page k re-asked about all k pages, and the backend paid a `stat` per
 *   entry to answer "already cached". Quadratic in the number of pages for an answer this side
 *   already had. Skipping the resolved ones leaves each append asking about its own page.
 *
 * The set of settled paths is mirrored in a ref rather than read off the map, so it can be consulted
 * without the map becoming an effect dependency. With the map in the deps, every resolution would
 * re-run the effect and turn one request per page into a chain of them.
 *
 * "Settled" is the backend's word, not this hook's guess, and that is the point. An entry that came
 * back without a derivative used to be left unrecorded so it would be asked about again, which is
 * right for a page whose misses exhausted the per-call generation budget, and wrong for every other
 * way a path can fail to resolve. Those other ways are permanent (a name this app did not write, a
 * machine with no FFmpeg, a source that is gone), so re-asking about them meant every page append
 * carried them again. The request grew with the number of pages scrolled instead of staying one
 * page's worth, which is the quadratic cost this hook exists to remove, and past the backend's
 * per-call ceiling it also logged a truncation warning per page. The backend now says which kind of
 * miss it was (`DisplayThumbnail`), and only the retryable kind is left out of the set.
 *
 * **Asking again is this hook's job, and waiting for the item list to change is not enough.** The
 * backend's own note on its refused-slot answer says "the caller already re-asks about this", which
 * was true of the case it was written for and not of the case that produces it. The request key is
 * derived from the items, so a re-ask only happens when a page is appended, and the backend admits
 * one resolve call at a time, so a page arriving while another holds that slot comes back entirely
 * retryable having decided nothing. On the *last* page of a channel there is no later append, so
 * that page would keep drawing full-resolution stored files for the rest of the session. That is
 * precisely the failure `MAX_GENERATIONS_PER_CALL` was raised from 64 to 100 to remove, reached
 * through a different door. So a request that settles nothing schedules its own re-ask, bounded by
 * `MAX_DISPLAY_RETRIES` so a backend that genuinely cannot answer is not polled forever.
 */
export function useDisplayThumbnails(
    thumbnailPaths: readonly (string | null | undefined)[],
    libraryPath: string
): ReadonlyMap<string, string> {
    const [displayThumbnails, setDisplayThumbnails] = useState<ReadonlyMap<string, string>>(
        EMPTY_DISPLAY_THUMBNAILS
    );

    // The paths the backend has answered for good. Resolved or permanently unavailable. A superset
    // of the map's keys, since a path that will never have a derivative is settled without appearing
    // there. See the note above on why this is a ref and not a read of the map itself.
    const settledPathsRef = useRef<Set<string>>(new Set());

    // Bumped when a request settled nothing, so the effect below re-runs without the item list
    // having had to change. See the "asking again" note in the doc comment for why waiting on the
    // list is not enough.
    const [retryTick, setRetryTick] = useState(0);

    // Retries already spent on the current request, and which request they belong to. Refs rather
    // than state. Resetting a counter when the request changes must not itself cause a render in the
    // commit where the fetch effect is already running, which is what a second piece of state here
    // would do (and it would fetch twice for it).
    const retriesSpentRef = useRef(0);
    const retriedRequestRef = useRef<string | null>(null);
    const retryTimerRef = useRef<number | null>(null);

    // A stable identity for "which paths are being asked about", so the effect below re-runs when
    // the set changes and not when the array is merely rebuilt with the same contents, which the
    // grid does on every render of its parent.
    const requestKey = useMemo(
        () =>
            thumbnailPaths
                .map((thumbnailPath) => thumbnailPath?.trim() ?? "")
                .filter((thumbnailPath) => thumbnailPath.length > 0)
                .join(REQUEST_KEY_SEPARATOR),
        [thumbnailPaths]
    );

    useEffect(() => {
        // A library change invalidates every resolved path at once (the derivatives are keyed by
        // content, but the paths they answer are relative to a library that is no longer the one in
        // use), so the accumulated map is dropped rather than merged into. The ref has to be cleared
        // with it, or the next request would skip paths whose derivatives no longer apply. This
        // effect is declared before the fetch below so it runs first in the same commit.
        settledPathsRef.current = new Set();
        setDisplayThumbnails(EMPTY_DISPLAY_THUMBNAILS);
        // Forces the retry budget below to reset on the next request too. Every path it was
        // counting attempts for belongs to a library that is no longer in use.
        retriedRequestRef.current = null;
    }, [libraryPath]);

    useEffect(() => {
        // A different set of paths is a different request, so it starts with a full retry budget.
        // Compared against a ref rather than reset by its own effect, because this runs again for
        // the *same* request on every retry tick and must not clear the count then.
        if (retriedRequestRef.current !== requestKey) {
            retriedRequestRef.current = requestKey;
            retriesSpentRef.current = 0;
        }

        const requested = requestKey
            .split(REQUEST_KEY_SEPARATOR)
            .filter((path) => path.length > 0 && !settledPathsRef.current.has(path));

        if (requested.length === 0 || !libraryPath.trim()) {
            return;
        }

        let disposed = false;

        void (async () => {
            try {
                const { displayPaths, settledPaths } = await resolveDisplayThumbnails(
                    requested,
                    libraryPath
                );

                if (disposed) {
                    return;
                }

                // Recorded before the state update rather than inside it. A state updater must stay
                // pure, and React may call it more than once for a single commit. Every settled path
                // is recorded, including the ones with no derivative. That is what stops a path
                // that can never resolve from riding along on every later request.
                for (const path of settledPaths) {
                    settledPathsRef.current.add(path);
                }

                // Nothing at all was settled, so this call decided nothing about any of these
                // paths. The backend was busy rather than unable to answer, which is what its
                // "budgetSpent" means. Re-ask on a timer instead of waiting for the item list to
                // change, because the list may never change again. The last page of a channel has
                // no later append behind it, so a request refused here would otherwise leave those
                // cards decoding the full-resolution stored file for the rest of the session. That
                // is the same outcome MAX_GENERATIONS_PER_CALL was raised from 64 to 100 to remove,
                // reached through a different door. The backend's single resolve slot.
                if (settledPaths.size === 0 && retriesSpentRef.current < MAX_DISPLAY_RETRIES) {
                    retriesSpentRef.current += 1;
                    retryTimerRef.current = window.setTimeout(() => {
                        retryTimerRef.current = null;
                        setRetryTick((tick) => tick + 1);
                    }, DISPLAY_RETRY_DELAY_MS);
                }

                // Checked after the ref update, not before it. A call that settled paths without
                // resolving any still has to be remembered, and returning early on an empty map
                // would throw that away and re-ask about all of them on the next page.
                if (displayPaths.size === 0) {
                    return;
                }

                setDisplayThumbnails((previous) => {
                    const merged = new Map(previous);

                    for (const [path, displayPath] of displayPaths) {
                        merged.set(path, displayPath);
                    }

                    return merged;
                });
            } catch (error) {
                // Purely an optimization. The grid is already rendering the stored thumbnails, so a
                // failure here costs nothing visible and must not reach the user as an error.
                logError("display-thumbnails", "Could not resolve display thumbnails.", error);
            }
        })();

        return () => {
            disposed = true;

            // A pending retry belongs to the request that scheduled it; a new request supersedes it
            // rather than running alongside it, and an unmount must not leave a timer setting state.
            if (retryTimerRef.current !== null) {
                window.clearTimeout(retryTimerRef.current);
                retryTimerRef.current = null;
            }
        };
    }, [requestKey, libraryPath, retryTick]);

    return displayThumbnails;
}
