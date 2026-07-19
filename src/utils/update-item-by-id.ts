// Returns `item` unchanged unless its `id` matches, in which case `updater(item)` is applied.
// Meant to be used inside an `Array.map` to replace a single row in an in-memory list while keeping
// every other element's identity stable (so memoized consumers of the unchanged rows do not
// re-render).
export function updateItemById<T extends { id: number }>(
    item: T,
    id: number,
    updater: (item: T) => T
): T {
    return item.id === id ? updater(item) : item;
}
