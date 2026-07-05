// The library summary loader lives in library-service (sanitizes the result and logs
// failures); this module re-exports it so the diagnostics layer shares that single
// implementation instead of a divergent copy.
export { createEmptyLibrarySummary, getLibrarySummary } from "./library-service";
