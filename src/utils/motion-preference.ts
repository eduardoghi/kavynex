// The motion preference is a per-device presentation choice like the color scheme, so it lives in
// the webview's localStorage (where Mantine keeps the color scheme too) rather than in the app
// settings row, which travels with the database.

export const MOTION_PREFERENCES = ["system", "reduce", "full"] as const;

export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

export const MOTION_PREFERENCE_STORAGE_KEY = "kavynex.motion-preference";

export const REDUCED_MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";

// Anything that is not one of the three known values (a missing key, a hand-edited entry, a value
// from a build that spelled them differently) reads as "system", which is the default and the one
// choice that cannot be wrong for the user: it is whatever their operating system already says.
export function parseMotionPreference(raw: unknown): MotionPreference {
    return MOTION_PREFERENCES.find((value) => value === raw) ?? "system";
}

// Whether motion should be reduced right now, given the stored preference and what the operating
// system reports. "system" defers entirely; the other two override it in their direction.
export function resolveReduceMotion(
    preference: MotionPreference,
    systemPrefersReducedMotion: boolean
): boolean {
    switch (preference) {
        case "reduce":
            return true;
        case "full":
            return false;
        case "system":
            return systemPrefersReducedMotion;
    }
}
