import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `convertFileSrc` (re-exported from tauri-platform) is what every thumbnail and every media file
// in the library is loaded through, and the URL it hands back is platform-dependent: Tauri's
// injected implementation returns `asset://localhost/<path>` everywhere except Windows, which
// gets `http://asset.localhost/<path>`. Neither form is covered by `'self'` - the document itself
// is served from `http://tauri.localhost`, a different origin - so both tokens have to be named
// in the CSP or the WebView refuses to load them.
//
// This is pinned in a test rather than left to review because nothing else can catch it. A unit
// test only ever sees a mocked convertFileSrc; `pnpm tauri dev` serves the page from the Vite
// origin, where Tauri injects no CSP header at all; and Tauri does not add these tokens for you
// (its set_csp only touches script-src/style-src and the isolation schema). The first thing to
// exercise the real CSP is a packaged build - which is exactly where dropping a token would show
// up as a library with no thumbnails and a player that cannot start.
const REQUIRED_ASSET_SOURCES = ["asset:", "http://asset.localhost"];

// The directives that actually serve library files: thumbnails/avatars, and video/audio.
const ASSET_DIRECTIVES = ["img-src", "media-src"];

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
    }
});
