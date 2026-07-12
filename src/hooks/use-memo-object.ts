import { useMemo } from "react";

// Returns a reference-stable object whose identity only changes when one of its top-level
// values changes (shallow compare). Lets a controller hook build its return object as a plain
// literal without hand-maintaining a parallel useMemo dependency array that lists every field.
// The object's keys must be static across renders (they always are for a controller's return),
// so the derived dependency array never changes length.
export function useMemoObject<T extends Record<string, unknown>>(value: T): T {
    const dependencies = Object.values(value);

    // The dependency array is derived dynamically from the object's own values, which
    // exhaustive-deps cannot statically verify - deriving the deps from the object is the entire
    // point of this helper, and this is the single audited place that does so.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => value, dependencies);
}
