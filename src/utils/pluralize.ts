// Formats a count with its noun, adding a trailing "s" (or the supplied irregular plural) unless the
// count is exactly 1. Replaces the "item(s)" style placeholder plural that reads as unfinished copy.
export function formatCount(count: number, singular: string, plural?: string): string {
    const noun = count === 1 ? singular : (plural ?? `${singular}s`);
    return `${count} ${noun}`;
}
