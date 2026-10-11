// How to start `pnpm <args>` from a script, as the `file`, `args` and `shell` to hand to
// `execFileSync` or `spawnSync`.
//
// pnpm is a `.cmd` shim on Windows, and Node refuses to spawn `.bat`/`.cmd` without a shell
// (CVE-2024-27980). With `shell: true` Node joins an argv array into a command line rather than
// passing it through, and warns about exactly that (DEP0190), since the array then escapes
// nothing. So on Windows the command line is built here, once, and only from arguments that need
// no quoting. Anything else is refused rather than quoted, because every caller passes literals
// written in its own file, and an argument that does not fit is a change that needs a different
// way to start pnpm. Elsewhere pnpm is started directly, with no shell.

const PLAIN_ARGUMENT = /^[A-Za-z0-9@:._/=-]+$/;

export function pnpmInvocation(args, platform = process.platform) {
    if (platform !== "win32") {
        return { file: "pnpm", args, shell: false };
    }

    for (const arg of args) {
        if (!PLAIN_ARGUMENT.test(arg)) {
            throw new Error(`refusing to pass ${JSON.stringify(arg)} to pnpm through a shell`);
        }
    }

    return { file: ["pnpm", ...args].join(" "), args: [], shell: true };
}
