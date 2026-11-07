// The interface is in English, so its numbers are too, whatever the system's language. Left to the
// system, a Portuguese Windows showed "1.204" in some places and "1,204" in others.
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function formatNumber(value: number): string {
    return NUMBER_FORMAT.format(value);
}

// A moment the app recorded (a backup, a mirror copy), with date and time, in English.
export function formatTimestamp(ms: number): string {
    return new Date(ms).toLocaleString("en-US");
}
