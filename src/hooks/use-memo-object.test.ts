import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMemoObject } from "./use-memo-object";

describe("useMemoObject", () => {
    it("keeps the same identity while every value is unchanged", () => {
        // The property every controller hook in this app depends on. `useHomeController` and its
        // siblings build their return object as a plain literal, so without this the object would be
        // new on every render and the `memo()` on every consumer below it would never hold.
        const { result, rerender } = renderHook(
            ({ items, onSelect }: { items: string[]; onSelect: () => void }) =>
                useMemoObject({ items, onSelect }),
            { initialProps: { items: ["a"], onSelect: () => {} } }
        );

        const first = result.current;

        rerender({ items: first.items, onSelect: first.onSelect });

        expect(result.current).toBe(first);
    });

    it("returns a new identity as soon as one value changes", () => {
        // The other direction, and the one that makes the test above mean something. A hook that
        // simply returned the first object forever would satisfy the stability assertion and hand
        // every consumer stale data.
        const { result, rerender } = renderHook(
            ({ count }: { count: number }) => useMemoObject({ count }),
            { initialProps: { count: 1 } }
        );

        const first = result.current;

        rerender({ count: 2 });

        expect(result.current).not.toBe(first);
        expect(result.current.count).toBe(2);
    });

    it("compares values shallowly, so a rebuilt-but-equal object counts as a change", () => {
        // Stated as a test rather than left to the doc comment, because it is the helper's one sharp
        // edge. The comparison is over the top-level values, so a nested literal rebuilt with equal
        // contents is a *different* value and does break the identity. A caller that wants stability
        // across that has to memoize the nested value itself, which is why the codebase passes
        // already-stable callbacks and state slices here rather than fresh literals.
        const { result, rerender } = renderHook(
            ({ filters }: { filters: { watched: string } }) => useMemoObject({ filters }),
            { initialProps: { filters: { watched: "all" } } }
        );

        const first = result.current;

        rerender({ filters: { watched: "all" } });

        expect(result.current).not.toBe(first);
    });

    it("does not change identity when a value is replaced by an equal primitive", () => {
        // The complement of the case above. Primitives compare by value, so re-deriving the same
        // string or number on each render is safe. This is what lets a controller pass a computed
        // count or a derived label straight through.
        const { result, rerender } = renderHook(
            ({ label }: { label: string }) => useMemoObject({ label }),
            { initialProps: { label: "12 items" } }
        );

        const first = result.current;

        rerender({ label: `${12} items` });

        expect(result.current).toBe(first);
    });

    it("returns the object it was handed, not a copy", () => {
        // The helper memoizes an identity; it must never clone. A copy would silently detach any
        // consumer that compares a field by reference against the source it came from.
        const source = { value: 1 };

        const { result } = renderHook(() => useMemoObject(source));

        expect(result.current).toBe(source);
    });
});
