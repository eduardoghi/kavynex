// The renderer half of the startup self-check (see src-tauri/src/commands/webview_check.rs for the
// whole rationale, including what this deliberately does not cover).
//
// Everything here runs inside the webview on purpose. The Tauri ACL gates what the *renderer* may
// call and is evaluated at runtime, and the packaged CSP is applied to the *document* and only in a
// bundled build, so neither can be exercised by anything the backend does on its own, and neither
// is reachable from `--smoke-test`, which exits inside `setup()` before the window opens.
//
// This module is in the production bundle by design. The shipped binary has to be able to check
// itself, without a second build that would then be a different binary. The cost on a normal launch
// is one `invoke` that returns null immediately.

import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand, listenTauri } from "./tauri-client";
import { convertFileSrc, getVersion } from "./tauri-platform";
import type { WebviewCheckReport } from "../types/generated/WebviewCheckReport";

// How long the asset probe waits for the image to load or fail. An `<img>` whose URL the CSP
// refuses fires `error` promptly, but one the asset protocol never answers fires nothing at all.
// which is the case this bound exists for, and the reason it cannot simply await the element.
// Comfortably under the backend watchdog's own deadline so this reports a named failure rather than
// being cut off by it.
const ASSET_PROBE_TIMEOUT_MS = 15_000;

// The event the listen probe subscribes to. Nothing ever emits it, and that is the point. What is
// being tested is whether `listen`/`unlisten` are permitted at all, which the ACL decides when the
// call is made rather than when a payload arrives. Kept local rather than added to
// constants/events.ts, which names events the backend actually emits.
const PROBE_EVENT_NAME = "kavynex-webview-check-probe";

function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

// Probes `core:app:allow-version`. A denied permission rejects rather than returning a blank
// string, so the failure is caught here and reported as a missing version.
async function probeAppVersion(failures: string[]): Promise<string | null> {
    try {
        return await getVersion();
    } catch (error) {
        failures.push(`getVersion() threw: ${describeError(error)}`);
        return null;
    }
}

// Probes `core:event:allow-listen` and `core:event:allow-unlisten`. Both halves matter and they are
// separate grants, so the unsubscribe is called inside the same `try` rather than left dangling. A
// build that granted only the first would otherwise pass. `UnlistenFn` returns void (it hands the
// removal to the backend without waiting), so there is nothing to await here; what is being tested
// is that the call is permitted at all.
async function probeEventListen(failures: string[]): Promise<boolean> {
    try {
        const unlisten = await listenTauri(PROBE_EVENT_NAME, () => {});
        unlisten();
        return true;
    } catch (error) {
        failures.push(`listen()/unlisten() threw: ${describeError(error)}`);
        return false;
    }
}

// Probes the asset-protocol scope grant on the cache directory and the CSP's img-src tokens, which
// together are what make every thumbnail and every video in the app load. An `<img>` rather than a
// `fetch`, because `connect-src` deliberately excludes `asset:`, so a fetch would fail by design
// and prove nothing. This is exactly how the app really draws a thumbnail.
function probeAssetLoad(assetPath: string, failures: string[]): Promise<boolean> {
    let assetUrl: string;

    try {
        assetUrl = convertFileSrc(assetPath);
    } catch (error) {
        failures.push(`convertFileSrc() threw: ${describeError(error)}`);
        return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
        const image = new Image();
        let settled = false;

        const settle = (loaded: boolean, reason?: string) => {
            if (settled) {
                return;
            }

            settled = true;
            window.clearTimeout(timeoutId);
            image.onload = null;
            image.onerror = null;

            if (reason) {
                failures.push(reason);
            }

            resolve(loaded);
        };

        const timeoutId = window.setTimeout(() => {
            settle(
                false,
                `the asset at ${assetUrl} neither loaded nor errored within ${ASSET_PROBE_TIMEOUT_MS}ms`
            );
        }, ASSET_PROBE_TIMEOUT_MS);

        image.onload = () => settle(true);
        image.onerror = () => settle(false, `the asset at ${assetUrl} failed to load`);

        image.src = assetUrl;
    });
}

// Runs every probe, so one failure never hides another. A report that names all three problems at
// once is what makes a badly narrowed capability list fixable in a single pass.
async function collectReport(assetPath: string): Promise<WebviewCheckReport> {
    const failures: string[] = [];

    const appVersion = await probeAppVersion(failures);
    const eventListenOk = await probeEventListen(failures);
    const assetLoadOk = await probeAssetLoad(assetPath, failures);

    return { appVersion, eventListenOk, assetLoadOk, failures };
}

/**
 * Asks the backend whether this launch is a webview check and, if it is, runs the probes and
 * reports the outcome. Resolves to whether a check ran, which is what the tests assert on; the
 * process itself is terminated by the backend once the report lands.
 *
 * Never throws. A normal launch must not be affected by anything here, so a failure to even ask is
 * swallowed. The backend's watchdog is what turns a check that could not report into a non-zero
 * exit, and outside a check run there is nothing to report at all.
 */
export async function runWebviewCheckIfRequested(): Promise<boolean> {
    try {
        const plan = await invokeCommand(TAURI_COMMANDS.BEGIN_WEBVIEW_CHECK);

        if (!plan) {
            return false;
        }

        const report = await collectReport(plan.assetPath);

        await invokeCommand(TAURI_COMMANDS.REPORT_WEBVIEW_CHECK, { report });

        return true;
    } catch (error) {
        // Reaching here during an actual check means the report could not be delivered, which the
        // backend watchdog already handles by timing out. Logged rather than rethrown so a normal
        // launch is never affected by a self-check concern.
        console.error("Webview check could not run:", error);
        return false;
    }
}
