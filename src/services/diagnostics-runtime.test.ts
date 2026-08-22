import { afterEach, describe, expect, it, vi } from "vitest";
import { getRuntimeDiagnosticsInfo } from "./diagnostics-runtime";

// The architecture is a substring guess over the user agent (the webview exposes nothing better
// without a permission prompt), so each of the strings the guess matches on is pinned here. A new
// Chromium or WebKit user-agent shape that stops matching would otherwise turn every Diagnostics
// report into "unknown" with nothing failing.
function stubNavigator(overrides: {
    userAgent?: string;
    platform?: string;
    userAgentDataPlatform?: string;
}): void {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(overrides.userAgent ?? "");
    vi.spyOn(navigator, "platform", "get").mockReturnValue(overrides.platform ?? "");

    if (overrides.userAgentDataPlatform !== undefined) {
        Object.defineProperty(navigator, "userAgentData", {
            configurable: true,
            value: { platform: overrides.userAgentDataPlatform },
        });
    }
}

describe("getRuntimeDiagnosticsInfo", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        // `userAgentData` is defined on the instance by the stub above, so restoreAllMocks does not
        // remove it; delete it explicitly or it leaks into the next test's platform lookup.
        delete (navigator as { userAgentData?: unknown }).userAgentData;
    });

    it.each([
        ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/126.0", "x64"],
        ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", "unknown"],
        ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15", "x64"],
        ["Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/605.1.15", "arm64"],
        ["Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36", "arm64"],
        ["Mozilla/5.0 (X11; Linux i686) AppleWebKit/605.1.15", "x86"],
        ["Mozilla/5.0 (X11; Linux amd64)", "x64"],
    ])("guesses the architecture from %s as %s", async (userAgent, expected) => {
        stubNavigator({ userAgent, platform: "Test" });

        await expect(getRuntimeDiagnosticsInfo()).resolves.toMatchObject({ arch: expected });
    });

    it("prefers userAgentData.platform over navigator.platform and trims it", async () => {
        stubNavigator({ platform: "Win32", userAgentDataPlatform: "  Windows  " });

        await expect(getRuntimeDiagnosticsInfo()).resolves.toMatchObject({ platform: "Windows" });
    });

    it("falls back to navigator.platform, and to unknown when neither says anything", async () => {
        stubNavigator({ platform: "MacIntel" });
        await expect(getRuntimeDiagnosticsInfo()).resolves.toMatchObject({ platform: "MacIntel" });

        stubNavigator({ platform: "   " });
        await expect(getRuntimeDiagnosticsInfo()).resolves.toEqual({
            platform: "unknown",
            arch: "unknown",
        });
    });
});
