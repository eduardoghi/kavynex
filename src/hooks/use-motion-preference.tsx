import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import {
    MOTION_PREFERENCE_STORAGE_KEY,
    REDUCED_MOTION_MEDIA_QUERY,
    parseMotionPreference,
    resolveReduceMotion,
    type MotionPreference,
} from "../utils/motion-preference";

export type MotionPreferenceController = {
    // What the user chose, either following the operating system or forcing one way.
    preference: MotionPreference;
    setPreference: (preference: MotionPreference) => void;
    // The resolved answer right now, after applying the preference to what the OS reports.
    reduceMotion: boolean;
};

// Name of the attribute the provider stamps on <html>. `src/index.css` keys the transition and
// animation cut-off on it, so one rule there covers Mantine's own transitions (modal enter/exit,
// the striped progress bar) as well as the inline transitions the cards declare. Attribute rather
// than the media query directly, because the user's override has to be able to disagree with the
// operating system in both directions, and CSS cannot invert a media query on its own.
export const REDUCE_MOTION_ATTRIBUTE = "data-reduce-motion";

// Fails safe for a consumer rendered outside the provider (a test, a stray component). Motion
// stays on and the setter does nothing, matching what the page did before this existed.
const MotionPreferenceContext = createContext<MotionPreferenceController>({
    preference: "system",
    setPreference: () => {},
    reduceMotion: false,
});

function readStoredPreference(): MotionPreference {
    try {
        return parseMotionPreference(window.localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY));
    } catch {
        // localStorage can throw (disabled storage, a webview profile that refuses it); the
        // preference then lives for the session only, which is the only fallback that keeps the
        // control working at all.
        return "system";
    }
}

function writeStoredPreference(preference: MotionPreference): void {
    try {
        window.localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, preference);
    } catch {
        // Same as above. A write failure costs persistence, not the feature.
    }
}

function systemPrefersReducedMotion(): boolean {
    return typeof window.matchMedia === "function"
        ? window.matchMedia(REDUCED_MOTION_MEDIA_QUERY).matches
        : false;
}

export function MotionPreferenceProvider({ children }: { children: ReactNode }): JSX.Element {
    const [preference, setPreferenceState] = useState<MotionPreference>(readStoredPreference);
    const [systemReduces, setSystemReduces] = useState<boolean>(systemPrefersReducedMotion);

    // Track the OS setting live, so flipping "reduce motion" in the system preferences while the
    // app is open takes effect without a restart. Only matters under "system", but the listener is
    // cheap and keeping it unconditional avoids a subscribe/unsubscribe dance on every change.
    useEffect(() => {
        if (typeof window.matchMedia !== "function") {
            return;
        }

        const mediaQuery = window.matchMedia(REDUCED_MOTION_MEDIA_QUERY);
        const onChange = (event: MediaQueryListEvent): void => {
            setSystemReduces(event.matches);
        };

        mediaQuery.addEventListener("change", onChange);

        return () => {
            mediaQuery.removeEventListener("change", onChange);
        };
    }, []);

    const setPreference = useCallback((next: MotionPreference): void => {
        setPreferenceState(next);
        writeStoredPreference(next);
    }, []);

    const reduceMotion = resolveReduceMotion(preference, systemReduces);

    // Stamp the resolved answer on <html> for the stylesheet. Removed on unmount so a provider
    // torn down (tests, a future second root) does not leave a stale attribute behind.
    useEffect(() => {
        document.documentElement.setAttribute(
            REDUCE_MOTION_ATTRIBUTE,
            reduceMotion ? "true" : "false"
        );

        return () => {
            document.documentElement.removeAttribute(REDUCE_MOTION_ATTRIBUTE);
        };
    }, [reduceMotion]);

    const value = useMemo<MotionPreferenceController>(
        () => ({ preference, setPreference, reduceMotion }),
        [preference, setPreference, reduceMotion]
    );

    return (
        <MotionPreferenceContext.Provider value={value}>{children}</MotionPreferenceContext.Provider>
    );
}

export function useMotionPreference(): MotionPreferenceController {
    return useContext(MotionPreferenceContext);
}
