import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `convertFileSrc` (re-exported from tauri-platform) is what every thumbnail and every media file
// in the library is loaded through, and the URL it hands back is platform-dependent: Tauri's
// injected implementation returns `asset://localhost/<path>` everywhere except Windows, which
// gets `http://asset.localhost/<path>`. Neither form is covered by `'self'` (the document itself
// is served from `http://tauri.localhost`, a different origin), so both tokens have to be named
// in the CSP or the WebView refuses to load them.
//
// This is pinned in a test rather than left to review because nothing else can catch it. A unit
// test only ever sees a mocked convertFileSrc; `pnpm tauri dev` serves the page from the Vite
// origin, where Tauri injects no CSP header at all; and Tauri does not add these tokens for you
// (its set_csp only touches script-src/style-src and the isolation schema). The first thing to
// exercise the real CSP is a packaged build, which is exactly where dropping a token would show
// up as a library with no thumbnails and a player that cannot start.
const REQUIRED_ASSET_SOURCES = ["asset:", "http://asset.localhost"];

// The directives that actually serve library files. thumbnails/avatars, and video/audio.
const ASSET_DIRECTIVES = ["img-src", "media-src"];

// Directives that must be present with exactly this source list, because each one closes a way
// out of the document that `default-src` does not cover.
//
// `form-action` is the one worth naming. Unlike script-src/frame-src/worker-src, it does NOT fall
// back to `default-src`, so leaving it out means "any destination". Every other outbound channel
// is already shut (`connect-src 'self' ipc:` blocks fetch/XHR/WebSocket, `object-src 'none'` blocks
// plugin content), which would leave a submitted form as the only way to navigate the document to
// an external origin with data attached. The app has no form that submits (every input is a React
// handler that goes over IPC), so 'none' costs nothing.
//
// The other two are pinned here rather than only in tauri.conf.json for the same reason the asset
// tokens are. A packaged build is the first thing that exercises the real CSP, so a directive
// dropped in an edit would not surface until a release.
const LOCKED_DOWN_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
    ["form-action", "'none'"],
    ["object-src", "'none'"],
    ["frame-ancestors", "'none'"],
];

type TauriConfig = {
    app: { security: { csp: string; devCsp: string } };
};

function readTauriConfig(): TauriConfig {
    const path = resolve(__dirname, "../../src-tauri/tauri.conf.json");
    return JSON.parse(readFileSync(path, "utf-8")) as TauriConfig;
}

// Pulls one directive's source list out of a CSP string ("img-src 'self' asset: ...").
function directiveSources(csp: string, directive: string): string[] {
    const found = csp
        .split(";")
        .map((part) => part.trim())
        .find((part) => part === directive || part.startsWith(`${directive} `));

    if (!found) {
        return [];
    }

    return found.split(/\s+/).slice(1);
}

describe("asset protocol CSP", () => {
    const config = readTauriConfig();

    for (const [label, csp] of [
        ["csp", config.app.security.csp],
        ["devCsp", config.app.security.devCsp],
    ] as const) {
        for (const directive of ASSET_DIRECTIVES) {
            it(`${label} allows both asset URL forms in ${directive}`, () => {
                const sources = directiveSources(csp, directive);

                expect(sources.length).toBeGreaterThan(0);

                for (const required of REQUIRED_ASSET_SOURCES) {
                    // `asset:` alone leaves Windows broken; `http://asset.localhost` alone leaves
                    // every other platform broken. They are the same capability, spelled the way
                    // each platform's webview needs.
                    expect(sources).toContain(required);
                }
            });
        }

        for (const [directive, expected] of LOCKED_DOWN_DIRECTIVES) {
            it(`${label} pins ${directive} to ${expected}`, () => {
                // Asserted as the exact source list, not just presence. A directive widened to
                // `'self'` (or to a host) is the regression worth failing on, and a containment
                // check would pass on it.
                expect(directiveSources(csp, directive)).toEqual([expected]);
            });
        }
    }
});
