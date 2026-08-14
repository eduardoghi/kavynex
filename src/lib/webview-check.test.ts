import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TAURI_COMMANDS } from "../constants/tauri-commands";
import type { WebviewCheckReport } from "../types/generated/WebviewCheckReport";

const invokeCommandMock = vi.fn();
const listenTauriMock = vi.fn();
const getVersionMock = vi.fn();
const convertFileSrcMock = vi.fn();

// The seam modules are mocked, never `@tauri-apps` itself. The convention this repo enforces
// everywhere except tauri-client.test.ts, which is the seam.
vi.mock("./tauri-client", () => ({
    invokeCommand: (...args: unknown[]) => invokeCommandMock(...args),
    listenTauri: (...args: unknown[]) => listenTauriMock(...args),
}));

vi.mock("./tauri-platform", () => ({
    getVersion: (...args: unknown[]) => getVersionMock(...args),
    convertFileSrc: (...args: unknown[]) => convertFileSrcMock(...args),
}));

const { runWebviewCheckIfRequested } = await import("./webview-check");

const PROBE_ASSET = "/cache/thumbs-temp/webview-check-abc.gif";
const PROBE_URL = "asset://localhost/cache/thumbs-temp/webview-check-abc.gif";

/** How the stubbed `<img>` should answer the probe. */
type AssetOutcome = "load" | "error" | "never";

/** The images the stub created, so a test can assert which URL was actually requested. */
let createdImageSources: string[];

/**
 * Replaces the global `Image` with one whose `src` setter schedules the configured outcome. jsdom
 * never fetches an image, so `onload`/`onerror` would otherwise fire for neither a working asset
 * nor a refused one, and "fires nothing at all" is itself one of the three cases under test.
 */
function stubImage(outcome: AssetOutcome): void {
    createdImageSources = [];

    class ImageStub {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(value: string) {
            createdImageSources.push(value);

            if (outcome === "never") {
                return;
            }

            // A real image settles asynchronously; resolving in a microtask keeps the probe's
            // settle-once guard exercised rather than short-circuited.
            queueMicrotask(() => {
                if (outcome === "load") {
                    this.onload?.();
                } else {
                    this.onerror?.();
                }
            });
        }
    }

    vi.stubGlobal("Image", ImageStub);
}

/**
 * The report the backend was handed, or undefined when the check never reported. Typed as the
 * generated binding so a field renamed on the Rust side breaks these assertions at compile time
 * rather than leaving them passing against a shape the backend no longer sends.
 */
function reportedPayload(): WebviewCheckReport | undefined {
    const call = invokeCommandMock.mock.calls.find(
        ([command]) => command === TAURI_COMMANDS.REPORT_WEBVIEW_CHECK
    );

    return (call?.[1] as { report: WebviewCheckReport } | undefined)?.report;
}

beforeEach(() => {
    vi.useFakeTimers();

    getVersionMock.mockResolvedValue("1.2.0");
    listenTauriMock.mockResolvedValue(vi.fn());
    convertFileSrcMock.mockReturnValue(PROBE_URL);
    invokeCommandMock.mockImplementation((command: string) => {
        if (command === TAURI_COMMANDS.BEGIN_WEBVIEW_CHECK) {
            return Promise.resolve({ assetPath: PROBE_ASSET });
        }

        return Promise.resolve(undefined);
    });

    stubImage("load");
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("runWebviewCheckIfRequested", () => {
    it("does nothing beyond the initial ask on a normal launch", async () => {
        // The behavior that makes this safe to call unconditionally from main.tsx: the backend
        // answers null, and not one probe runs. A regression here would put an image load and an
        // event subscription on every user's startup path.
        invokeCommandMock.mockResolvedValue(null);

        await expect(runWebviewCheckIfRequested()).resolves.toBe(false);

        expect(invokeCommandMock).toHaveBeenCalledTimes(1);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.BEGIN_WEBVIEW_CHECK);
        expect(getVersionMock).not.toHaveBeenCalled();
        expect(listenTauriMock).not.toHaveBeenCalled();
        expect(convertFileSrcMock).not.toHaveBeenCalled();
    });

    it("reports every probe as passing when the webview can do all three", async () => {
        await expect(runWebviewCheckIfRequested()).resolves.toBe(true);

        expect(reportedPayload()).toEqual({
            appVersion: "1.2.0",
            eventListenOk: true,
            assetLoadOk: true,
            failures: [],
        });
    });

    it("loads the asset through convertFileSrc rather than the raw path", async () => {
        // The whole point of the asset probe: a raw filesystem path in an `<img>` proves nothing
        // about the asset protocol or the CSP, which is what this is here to exercise.
        await runWebviewCheckIfRequested();

        expect(convertFileSrcMock).toHaveBeenCalledWith(PROBE_ASSET);
        expect(createdImageSources).toEqual([PROBE_URL]);
    });

    it("unsubscribes the probe listener so both event grants are exercised", async () => {
        // listen and unlisten are separate permissions, so a build granting only the first must not
        // pass. That is only true if the unsubscribe is actually called.
        const unlisten = vi.fn();
        listenTauriMock.mockResolvedValue(unlisten);

        await runWebviewCheckIfRequested();

        expect(unlisten).toHaveBeenCalledTimes(1);
        expect(reportedPayload()?.eventListenOk).toBe(true);
    });

    it("reports a refused getVersion without a version and with the reason", async () => {
        getVersionMock.mockRejectedValue(new Error("app.version not allowed"));

        await runWebviewCheckIfRequested();

        const report = reportedPayload();
        expect(report?.appVersion).toBeNull();
        expect(report?.failures).toEqual([
            "getVersion() threw: app.version not allowed",
        ]);
    });

    it("reports a refused event subscription", async () => {
        listenTauriMock.mockRejectedValue(new Error("event.listen not allowed"));

        await runWebviewCheckIfRequested();

        const report = reportedPayload();
        expect(report?.eventListenOk).toBe(false);
        expect(report?.failures).toEqual([
            "listen()/unlisten() threw: event.listen not allowed",
        ]);
    });

    it("reports an asset the webview refused to load", async () => {
        // What a missing img-src token or an unauthorized directory looks like from here.
        stubImage("error");

        await runWebviewCheckIfRequested();

        const report = reportedPayload();
        expect(report?.assetLoadOk).toBe(false);
        expect(report?.failures).toEqual([`the asset at ${PROBE_URL} failed to load`]);
    });

    it("reports an asset that neither loads nor errors once the probe times out", async () => {
        // The case the timeout exists for: an `<img>` whose URL the asset protocol never answers
        // fires no event at all, so without a deadline the check would hang until the backend
        // watchdog killed it. Losing the named failure this produces.
        stubImage("never");

        const pending = runWebviewCheckIfRequested();
        await vi.advanceTimersByTimeAsync(15_000);

        await expect(pending).resolves.toBe(true);

        const report = reportedPayload();
        expect(report?.assetLoadOk).toBe(false);
        expect(report?.failures).toHaveLength(1);
        expect(String(report?.failures?.[0])).toContain("neither loaded nor errored");
    });

    it("runs every probe even when an earlier one fails", async () => {
        // A badly narrowed capability list fails several probes at once, and fixing them one
        // release at a time is not an option, so a rejection must not short-circuit the rest.
        getVersionMock.mockRejectedValue(new Error("denied"));
        listenTauriMock.mockRejectedValue(new Error("denied"));
        stubImage("error");

        await runWebviewCheckIfRequested();

        const report = reportedPayload();
        expect(report?.appVersion).toBeNull();
        expect(report?.eventListenOk).toBe(false);
        expect(report?.assetLoadOk).toBe(false);
        expect(report?.failures).toHaveLength(3);
    });

    it("reports a convertFileSrc that throws without attempting the load", async () => {
        convertFileSrcMock.mockImplementation(() => {
            throw new Error("convertFileSrc unavailable");
        });

        await runWebviewCheckIfRequested();

        expect(createdImageSources).toEqual([]);
        expect(reportedPayload()?.assetLoadOk).toBe(false);
        expect(reportedPayload()?.failures).toEqual([
            "convertFileSrc() threw: convertFileSrc unavailable",
        ]);
    });

    it("never throws when the backend cannot even be asked", async () => {
        // A normal launch must not be affected by a self-check concern, so a failure to reach the
        // backend is swallowed rather than propagated into main.tsx.
        invokeCommandMock.mockRejectedValue(new Error("ipc unavailable"));

        await expect(runWebviewCheckIfRequested()).resolves.toBe(false);
    });

    it("never throws when the report itself cannot be delivered", async () => {
        // The backend watchdog is what covers this case; here the contract is only that nothing
        // escapes into the caller.
        invokeCommandMock.mockImplementation((command: string) => {
            if (command === TAURI_COMMANDS.BEGIN_WEBVIEW_CHECK) {
                return Promise.resolve({ assetPath: PROBE_ASSET });
            }

            return Promise.reject(new Error("report rejected"));
        });

        await expect(runWebviewCheckIfRequested()).resolves.toBe(false);
    });
});
