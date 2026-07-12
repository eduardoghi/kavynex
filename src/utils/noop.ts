// Stable no-op callback, so callers that conditionally disable a handler (e.g. a locked
// modal's onClose) do not pass a fresh function on every render.
export const NOOP = (): void => {};
