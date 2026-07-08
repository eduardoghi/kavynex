/**
 * Helpers for the optional "published date" field in the add-media modal. Kept free of React
 * so the masking and ISO<->display conversion can be unit-tested directly.
 *
 * The field is displayed and typed as `dd/mm/yyyy`; it is stored as an ISO `yyyy-mm-dd`.
 */

/** Turns a stored ISO date (`yyyy-mm-dd`) into the `dd/mm/yyyy` display form. */
export function formatPublishedAtForDisplay(value: string): string {
    const normalized = value.trim();

    if (!normalized) {
        return "";
    }

    const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (isoMatch) {
        const year = isoMatch[1];
        const month = isoMatch[2];
        const day = isoMatch[3];

        return `${day}/${month}/${year}`;
    }

    return normalized;
}

function normalizePublishedAtDigits(value: string): string {
    return value.replace(/\D/g, "").slice(0, 8);
}

/** Progressively masks raw input into `dd`, `dd/mm` or `dd/mm/yyyy` as digits are typed. */
export function applyPublishedAtMask(value: string): string {
    const digits = normalizePublishedAtDigits(value);

    if (digits.length <= 2) {
        return digits;
    }

    if (digits.length <= 4) {
        return `${digits.slice(0, 2)}/${digits.slice(2)}`;
    }

    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)}`;
}

/**
 * Converts a `dd/mm/yyyy` display value into a stored ISO `yyyy-mm-dd`. Returns "" when the
 * value is incomplete or not a real calendar date, so a partially typed date is treated as
 * "no date yet" rather than a bogus one.
 */
export function displayDateToIso(value: string): string {
    const normalized = value.trim();

    if (!normalized) {
        return "";
    }

    const match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

    if (!match) {
        return "";
    }

    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);

    if (
        !Number.isInteger(day) ||
        !Number.isInteger(month) ||
        !Number.isInteger(year) ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31
    ) {
        return "";
    }

    const date = new Date(year, month - 1, day);

    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        return "";
    }

    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
