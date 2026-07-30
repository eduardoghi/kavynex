import { useEffect, useMemo, useRef, useState } from "react";
import { resolveDisplayThumbnails } from "../services/thumbnail-service";
import { logError } from "../utils/app-logger";

const EMPTY_DISPLAY_THUMBNAILS: ReadonlyMap<string, string> = new Map();

// Joins the requested paths into the effect's dependency key. A newline, not a space: a library
// path is app-written and content-addressed today (`thumbnails/thumb_<sha256>.jpg`), but the value
// comes out of the database, so a row written by an older build or arriving through an import can
// hold anything - and a space in one would split into two path fragments that resolve to nothing,
// which surfaces as a thumbnail that silently never gets a derivative. A newline cannot appear in a
// path on Windows and is not producible by any of this app's writers.
const REQUEST_KEY_SEPARATOR = "\n";

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
 *   every scroll tick - that is what `useVirtualizer` does - and it passes every row loaded so far,
 *   not just the visible window. Rebuilding the key in the hook body therefore meant a map, a filter
 *   and a join over thousands of strings per frame, allocating a several-hundred-kilobyte string each
 *   time. That is a scroll-jank source that grows with the library, in the hook whose entire purpose
 *   is to make scrolling cheaper.
 * - **Only paths without a derivative yet are asked about.** Each request otherwise carried every
 *   loaded path, so appending page k re-asked about all k pages, and the backend paid a `stat` per
 *   entry to answer "already cached" - quadratic in the number of pages for an answer this side
 *   already had. Skipping the resolved ones leaves each append asking about its own page.
 *
 * The set of settled paths is mirrored in a ref rather than read off the map, so it can be consulted
 * without the map becoming an effect dependency: with the map in the deps, every resolution would
 * re-run the effect and turn one request per page into a chain of them.
 *
 * "Settled" is the backend's word, not this hook's guess, and that is the point. An entry that came
 * back without a derivative used to be left unrecorded so it would be asked about again - which is
 * right for a page whose misses exhausted the per-call generation budget, and wrong for every other
 * way a path can fail to resolve. Those other ways are permanent (a name this app did not write, a
 * machine with no FFmpeg, a source that is gone), so re-asking about them meant every page append
 * carried them again: the request grew with the number of pages scrolled instead of staying one
 * page's worth, which is the quadratic cost this hook exists to remove, and past the backend's
 * per-call ceiling it also logged a truncation warning per page. The backend now says which kind of
 * miss it was (`DisplayThumbnail`), and only the retryable kind is left out of the set.
 */
export function useDisplayThumbnails(
    thumbnailPaths: readonly (string | null | undefined)[],
    libraryPath: string
): ReadonlyMap<string, string> {
    const [displayThumbnails, setDisplayThumbnails] = useState<ReadonlyMap<string, string>>(
        EMPTY_DISPLAY_THUMBNAILS
    );

    // The paths the backend has answered for good - resolved or permanently unavailable. A superset
    // of the map's keys, since a path that will never have a derivative is settled without appearing
    // there. See the note above on why this is a ref and not a read of the map itself.
    const settledPathsRef = useRef<Set<string>>(new Set());

    // A stable identity for "which paths are being asked about", so the effect below re-runs when
    // the set changes and not when the array is merely rebuilt with the same contents - which the
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
    }, [libraryPath]);

    useEffect(() => {
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

                // Recorded before the state update rather than inside it: a state updater must stay
                // pure, and React may call it more than once for a single commit. Every settled path
                // is recorded, including the ones with no derivative - that is what stops a path
                // that can never resolve from riding along on every later request.
                for (const path of settledPaths) {
                    settledPathsRef.current.add(path);
                }

                // Checked after the ref update, not before it: a call that settled paths without
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
                // Purely an optimization: the grid is already rendering the stored thumbnails, so a
                // failure here costs nothing visible and must not reach the user as an error.
                logError("display-thumbnails", "Could not resolve display thumbnails.", error);
            }
        })();

        return () => {
            disposed = true;
        };
    }, [requestKey, libraryPath]);

    return displayThumbnails;
}
