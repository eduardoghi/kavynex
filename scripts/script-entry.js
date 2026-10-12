// Whether the module whose `import.meta.url` is given is the script `node` was started with.
//
// Comparing `import.meta.url` with `process.argv[1]` as strings does not work. The URL
// percent-encodes a space or an accented letter and the path does not, so in a checkout under
// `C:\Users\João Silva\` or `dir com espaço` every script would skip its main block and exit 0. The
// gates would pass without running and `before-build.js` would leave a stale `dist/` to be bundled.
// Comparing the two as paths is what the check means.

import { realpathSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

function realPath(path) {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

export function isMainModule(metaUrl, entry = process.argv[1], platform = process.platform) {
    if (!entry) {
        return false;
    }

    const started = realPath(resolve(entry));
    const self = realPath(fileURLToPath(metaUrl));

    // Windows paths compare without regard to case, and the drive letter in particular comes back
    // in either case depending on how the script was launched.
    if (platform === "win32") {
        return started.toLowerCase() === self.toLowerCase();
    }

    return started === self;
}
