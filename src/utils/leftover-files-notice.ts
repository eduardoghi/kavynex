// The notice shown when a deletion removed the row but not every file behind it. The files are left
// as orphans, which Diagnostics lists and can remove.
export function leftoverFilesNotice(what: "media" | "channel", count: number): string {
    const files = count === 1 ? "1 of its files" : `${count} of its files`;

    return `The ${what} was deleted, but ${files} could not be removed from the library folder. Diagnostics can remove leftover files later.`;
}

// The same for a channel avatar that was replaced or removed while its old file could not be.
export function leftoverAvatarNotice(): string {
    return "The channel avatar was changed, but the previous image could not be removed from the library folder. Diagnostics can remove leftover files later.";
}
