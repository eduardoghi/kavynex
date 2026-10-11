// `tauri build`'s beforeBuildCommand. Builds the frontend, unless the release workflow already did.
//
// The release builds the frontend in a step of its own, and then tauri-action runs `tauri build`
// with the updater signing key in its environment. Running `pnpm build` again from there put tsc,
// Vite, Rolldown and every PostCSS plugin in a process that could read that key, which is the whole
// JavaScript dev tree rather than the Rust crates RELEASE-SECURITY.md accepts the risk for. The
// workflow sets KAVYNEX_FRONTEND_PREBUILT on that step, and this then only checks that `dist/` is
// there, so nothing but this file runs with the key.

import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { isMainModule } from "./script-entry.js";
import { pnpmInvocation } from "./pnpm-invocation.js";

// What to do, given the environment and whether `dist/index.html` exists. Pure, so the two ways it
// can go wrong (skipping a build nobody did, building with the key in the environment) are tested.
export function planFrontendBuild(env, distIsBuilt) {
    if (env.KAVYNEX_FRONTEND_PREBUILT !== "1") {
        return { action: "build" };
    }

    if (!distIsBuilt) {
        return {
            action: "fail",
            message:
                "KAVYNEX_FRONTEND_PREBUILT is set but dist/index.html is missing. Build the frontend before tauri build.",
        };
    }

    return { action: "skip" };
}

// Only run when invoked as a script, so the export above stays unit-testable.
if (isMainModule(import.meta.url)) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const plan = planFrontendBuild(process.env, existsSync(join(root, "dist", "index.html")));

    if (plan.action === "fail") {
        console.error(plan.message);
        process.exit(1);
    }

    if (plan.action === "skip") {
        console.log("The frontend was built by an earlier step, so it is not rebuilt here.");
        process.exit(0);
    }

    // pnpm is a .cmd shim on Windows, which only a shell can start (see pnpm-invocation.js).
    const pnpm = pnpmInvocation(["build"]);
    const result = spawnSync(pnpm.file, pnpm.args, {
        cwd: root,
        stdio: "inherit",
        shell: pnpm.shell,
    });

    process.exit(result.status ?? 1);
}
