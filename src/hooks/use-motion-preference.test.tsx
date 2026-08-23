import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
    MOTION_PREFERENCE_STORAGE_KEY,
    REDUCED_MOTION_MEDIA_QUERY,
} from "../utils/motion-preference";
import {
    MotionPreferenceProvider,
    REDUCE_MOTION_ATTRIBUTE,
    useMotionPreference,
} from "./use-motion-preference";

type ChangeListener = (event: MediaQueryListEvent) => void;

// A matchMedia stub the test can drive: `matches` is what the OS reports, and `fire` flips it the
// way a live change to the system preference would, through the listener the provider registered.
function installMatchMedia(initialMatches: boolean) {
    let matches = initialMatches;
    const listeners = new Set<ChangeListener>();

    const matchMedia = vi.fn((query: string) => ({
        get matches() {
            return matches;
        },
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn((_type: string, listener: ChangeListener) => {
            listeners.add(listener);
        }),
        removeEventListener: vi.fn((_type: string, listener: ChangeListener) => {
            listeners.delete(listener);
        }),
        dispatchEvent: vi.fn(),
    }));

    Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: matchMedia,
    });

    return {
        matchMedia,
        fire(next: boolean) {
            matches = next;
            for (const listener of listeners) {
                listener({ matches: next } as MediaQueryListEvent);
            }
        },
        listenerCount: () => listeners.size,
    };
}

function wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <MotionPreferenceProvider>{children}</MotionPreferenceProvider>;
}

describe("useMotionPreference", () => {
    beforeEach(() => {
        window.localStorage.clear();
        document.documentElement.removeAttribute(REDUCE_MOTION_ATTRIBUTE);
    });

    afterEach(() => {
        document.documentElement.removeAttribute(REDUCE_MOTION_ATTRIBUTE);
    });

    it("follows the operating system by default and stamps the answer on <html>", () => {
        installMatchMedia(true);

        const { result } = renderHook(() => useMotionPreference(), { wrapper });

        expect(result.current.preference).toBe("system");
        expect(result.current.reduceMotion).toBe(true);
        expect(document.documentElement.getAttribute(REDUCE_MOTION_ATTRIBUTE)).toBe("true");
    });

    it("asks matchMedia for the reduced-motion query specifically", () => {
        const media = installMatchMedia(false);

        renderHook(() => useMotionPreference(), { wrapper });

        expect(media.matchMedia).toHaveBeenCalledWith(REDUCED_MOTION_MEDIA_QUERY);
    });

    it("tracks a live change to the system preference while following it", () => {
        const media = installMatchMedia(false);

        const { result } = renderHook(() => useMotionPreference(), { wrapper });
        expect(result.current.reduceMotion).toBe(false);

        act(() => media.fire(true));

        expect(result.current.reduceMotion).toBe(true);
        expect(document.documentElement.getAttribute(REDUCE_MOTION_ATTRIBUTE)).toBe("true");
    });

    it("lets the user override the operating system in both directions and persists the choice", () => {
        const media = installMatchMedia(true);

        const { result } = renderHook(() => useMotionPreference(), { wrapper });

        act(() => result.current.setPreference("full"));
        expect(result.current.reduceMotion).toBe(false);
        expect(document.documentElement.getAttribute(REDUCE_MOTION_ATTRIBUTE)).toBe("false");
        expect(window.localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY)).toBe("full");

        // An OS change no longer moves the answer while an override is in force.
        act(() => media.fire(false));
        act(() => media.fire(true));
        expect(result.current.reduceMotion).toBe(false);

        act(() => result.current.setPreference("reduce"));
        expect(result.current.reduceMotion).toBe(true);
        expect(window.localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY)).toBe("reduce");

        act(() => result.current.setPreference("system"));
        expect(result.current.reduceMotion).toBe(true);
        expect(window.localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY)).toBe("system");
    });

    it("reads a stored choice back on the next mount", () => {
        installMatchMedia(true);
        window.localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, "full");

        const { result } = renderHook(() => useMotionPreference(), { wrapper });

        expect(result.current.preference).toBe("full");
        expect(result.current.reduceMotion).toBe(false);
    });

    it("treats an unknown stored value as following the system", () => {
        installMatchMedia(false);
        window.localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, "sometimes");

        const { result } = renderHook(() => useMotionPreference(), { wrapper });

        expect(result.current.preference).toBe("system");
    });

    it("removes the listener and the attribute when the provider unmounts", () => {
        const media = installMatchMedia(false);

        const { unmount } = renderHook(() => useMotionPreference(), { wrapper });
        expect(media.listenerCount()).toBe(1);
        expect(document.documentElement.hasAttribute(REDUCE_MOTION_ATTRIBUTE)).toBe(true);

        unmount();

        expect(media.listenerCount()).toBe(0);
        expect(document.documentElement.hasAttribute(REDUCE_MOTION_ATTRIBUTE)).toBe(false);
    });

    it("fails safe outside the provider: motion on, setter inert", () => {
        installMatchMedia(true);

        const { result } = renderHook(() => useMotionPreference());

        expect(result.current.reduceMotion).toBe(false);
        act(() => result.current.setPreference("reduce"));
        expect(result.current.reduceMotion).toBe(false);
    });
});
