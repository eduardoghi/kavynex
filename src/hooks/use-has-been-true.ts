import { useRef } from "react";

/**
 * True from the first render where `value` is true, and true for every render after it.
 *
 * Written for one job: mounting a lazily-loaded modal the first time it opens, and keeping it
 * mounted once it has. Both halves matter and neither is the obvious `{opened && <Modal />}`.
 *
 * Deferring the mount is what makes `React.lazy` do anything for a modal at all. A Mantine modal is
 * mounted unconditionally and told whether it is `opened`, so rendering a lazy component that way
 * requests its chunk on the first paint - which is exactly the cost the split was meant to remove.
 *
 * Keeping it mounted afterwards is what `{opened && ...}` gets wrong. Unmounting on close cuts the
 * modal's own exit transition, so it vanishes instead of fading, and it throws away a chunk that is
 * already loaded. Latching means the first open pays a frame or two for the chunk and every later
 * one is instant.
 *
 * A ref rather than state, because flipping it must not itself schedule a render: the render that
 * turns `value` true is already the one that will mount the component, and a `setState` here would
 * add a second pass to reach the same output.
 */
export function useHasBeenTrue(value: boolean): boolean {
    const hasBeenTrue = useRef(false);

    if (value) {
        hasBeenTrue.current = true;
    }

    return hasBeenTrue.current;
}
