import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
}

beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    });

    Object.defineProperty(globalThis, "ResizeObserver", {
        writable: true,
        configurable: true,
        value: ResizeObserverMock,
    });

    const storage = (() => {
        let store: Record<string, string> = {};

        return {
            getItem: (key: string): string | null => store[key] ?? null,
            setItem: (key: string, value: string): void => {
                store[key] = String(value);
            },
            removeItem: (key: string): void => {
                delete store[key];
            },
            clear: (): void => {
                store = {};
            },
        };
    })();

    Object.defineProperty(window, "localStorage", {
        writable: true,
        configurable: true,
        value: storage,
    });
});

beforeEach(() => {
    window.localStorage.clear();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    vi.clearAllMocks();
});