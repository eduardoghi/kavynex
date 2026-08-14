// CI gate over the mapping between the Tauri APIs the frontend seam calls and the permissions
// `src-tauri/capabilities/` grants.
//
// `docs/THREAT-MODEL.md` states that the grant list is "the exact list the app uses, not a preset",
// and that the seam rule is what makes that auditable: `src/lib/tauri-client.ts` and
// `src/lib/tauri-platform.ts` are the only files allowed to import `@tauri-apps` (enforced by
// eslint), so the used surface is a two-file read. That is true, and it was still held by nothing
// but someone remembering to do the read.
//
// The failure it leaves open is the one that document describes: a new Tauri API added to a seam
// without its permission surfaces "on the first click a user makes". Nothing before this ran the
// ACL. `cargo test` never initializes the Tauri runtime, `pnpm build` only emits the bundle, and
// `--smoke-test` exits inside `setup()`. `--webview-check` (release.yml) closes the runtime half for
// the three grants it can exercise without a side effect; the four plugin grants cannot be probed
// that way (a file picker, a browser launch, a network call, a restart) and were left to a manual
// pass that was never written down.
//
// This closes the *declaration* half instead, which is where that drift actually happens, and it
// runs on every push rather than only on a release.
//
// What it proves and what it does not, stated exactly, because a gate that overstates itself is
// worse than none. It does NOT prove a granted permission works at runtime. That needs the ACL,
// which only the renderer evaluates. What it proves is that the two lists cannot drift apart
// silently: a binding added to a seam fails here until its permission is decided, a permission
// granted for nothing fails here too, and an entry naming an API that no longer exists cannot rot
// in place. The over-grant direction is not hypothetical. The list started as the scaffolded
// `core:default`, which expanded to 92 individual permissions, and stayed that way through four
// rounds of capability hardening because nothing was comparing it to the two files above.
//
// Usage:
//     node scripts/verify-capability-surface.js
//     node scripts/verify-capability-surface.js --print   # emit the current seam surface

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

// The two files eslint permits to import `@tauri-apps`, relative to the repository root. Hard-coded
// rather than discovered: that is the point of the rule, and a scan that found a third file would be
// reporting an eslint violation this script has no business re-deciding.
const SEAM_FILES = ["src/lib/tauri-client.ts", "src/lib/tauri-platform.ts"];

// Which permissions each Tauri API the seams import requires.
//
// Hand-declared, and it has to be: `getVersion` needs `core:app:allow-version` because of what the
// binding does, which no syntax reveals. The same shape, and the same reasoning, as
// `DECLARED_PATH_SURFACE` in verify-command-path-surface.js. The value is not that the script knows
// the mapping, it is that adding a binding without deciding its entry fails the run.
//
// An empty `permissions` array is a real answer, not a placeholder, and the three that carry one are
// the cases `docs/THREAT-MODEL.md` calls out explicitly: `convertFileSrc` builds a URL string in the
// renderer, `Channel` is part of the IPC mechanism rather than a command, and `invoke` reaches this
// app's own `#[tauri::command]`s, which the ACL does not gate at all (which is exactly why the Rust
// command layer, not the ACL, is the trust boundary that document is about).
export const DECLARED_CAPABILITY_SURFACE = [
    { binding: "invoke", module: "@tauri-apps/api/core", permissions: [] },
    { binding: "Channel", module: "@tauri-apps/api/core", permissions: [] },
    { binding: "convertFileSrc", module: "@tauri-apps/api/core", permissions: [] },
    // Both halves, because they are separate grants and `listen` hands back the unsubscribe that
    // needs the second one. A build holding only `allow-listen` would leak a subscription on every
    // teardown. The webview check probes both for the same reason.
    {
        binding: "listen",
        module: "@tauri-apps/api/event",
        permissions: ["core:event:allow-listen", "core:event:allow-unlisten"],
    },
    { binding: "getVersion", module: "@tauri-apps/api/app", permissions: ["core:app:allow-version"] },
    { binding: "open", module: "@tauri-apps/plugin-dialog", permissions: ["dialog:allow-open"] },
    { binding: "save", module: "@tauri-apps/plugin-dialog", permissions: ["dialog:allow-save"] },
    { binding: "openUrl", module: "@tauri-apps/plugin-opener", permissions: ["opener:allow-open-url"] },
    { binding: "relaunch", module: "@tauri-apps/plugin-process", permissions: ["process:allow-restart"] },
    { binding: "check", module: "@tauri-apps/plugin-updater", permissions: ["updater:default"] },
];

// Every value binding a file imports or re-exports from an `@tauri-apps` module, with the module it
// came from.
//
// Type-only bindings are skipped: `type Update`, `type Event` and `type UnlistenFn` are erased at
// compile time and call nothing, so requiring a permission entry for them would be requiring one for
// a name that never reaches the ACL. A binding renamed on the way out (`open as openFileDialog`) is
// recorded under its *original* name, which is what the permission is about. The alias is a
// readability choice at the seam and must not be able to change what this gate matches on.
export function extractTauriBindings(sourceContent) {
    const bindings = [];
    const statement = /(?:import|export)\s*\{([\s\S]*?)\}\s*from\s*["'](@tauri-apps\/[^"']+)["']/g;

    for (const match of sourceContent.matchAll(statement)) {
        const [, clause, module] = match;

        for (const raw of clause.split(",")) {
            const entry = raw.trim();

            if (!entry || /^type\s/.test(entry)) {
                continue;
            }

            const binding = entry.split(/\s+as\s+/)[0].trim();

            if (binding) {
                bindings.push({ binding, module });
            }
        }
    }

    return bindings;
}

// Every permission identifier granted across the capability files, deduplicated.
//
// A grant is either a bare identifier string or an object carrying a scope (`opener:allow-open-url`
// with its three allowed URLs). Only the identifier is read here: whether that scope is *right* is a
// judgment this gate deliberately does not make, and the URL list is pinned separately by the
// threat-model review.
export function extractGrantedPermissions(capabilitySources) {
    const granted = new Set();

    for (const { content } of capabilitySources) {
        const capability = JSON.parse(content);

        for (const permission of capability.permissions ?? []) {
            if (typeof permission === "string") {
                granted.add(permission);
            } else if (permission && typeof permission.identifier === "string") {
                granted.add(permission.identifier);
            }
        }
    }

    return granted;
}

// Whether `identifier` names a permission (or a plugin's default set) that actually exists.
//
// The last `:` splits the plugin key from the permission name, which is what makes both shapes work:
// `core:app:allow-version` is the `allow-version` permission of the `core:app` plugin, and
// `updater:default` is the `updater` plugin's default set, which lives under `default_permission`
// rather than in the `permissions` map, so it needs its own branch.
export function permissionExists(identifier, aclManifest) {
    const lastColon = identifier.lastIndexOf(":");

    if (lastColon === -1) {
        return false;
    }

    const plugin = identifier.slice(0, lastColon);
    const name = identifier.slice(lastColon + 1);
    const manifest = aclManifest[plugin];

    if (!manifest) {
        return false;
    }

    if (name === "default") {
        return manifest.default_permission != null;
    }

    return Boolean(manifest.permissions?.[name]) || Boolean(manifest.permission_sets?.[name]);
}

/**
 * Decides the gate from the raw file contents, returning `{ ok, message }` rather than reading files
 * or exiting itself: the same shape as the other verify-* scripts, so every refusal branch is
 * unit-testable.
 *
 * `aclManifest` is optional. It is `src-tauri/gen/schemas/acl-manifests.json`, which `tauri build`
 * generates and `.gitignore` excludes, so it is present locally and absent in a CI job that never
 * builds the Rust side. When it is there, each granted identifier is additionally checked to name a
 * permission that really exists, which catches a typo (`dialog:allow-opne`) that would otherwise
 * only surface on a user's first click. When it is not, that check is *reported as skipped* rather
 * than silently passing, because a check that quietly stops checking is the failure this whole file
 * is about.
 */
export function verifyCapabilitySurface({ seams, capabilities, aclManifest = null }) {
    const problems = [];

    const seamBindings = seams.flatMap(({ name, content }) =>
        extractTauriBindings(content).map((entry) => ({ ...entry, file: name }))
    );

    if (seamBindings.length === 0) {
        return {
            ok: false,
            message:
                "No @tauri-apps import was found in either seam file. Either the seam moved or this scan no longer matches it - and an empty surface would make every check below pass vacuously.",
        };
    }

    const declaredByBinding = new Map(
        DECLARED_CAPABILITY_SURFACE.map((entry) => [entry.binding, entry])
    );

    // A binding the seam imports with no entry here: the author has to decide which permission it
    // needs, which is the whole point of the gate.
    const undeclared = seamBindings.filter((entry) => !declaredByBinding.has(entry.binding));

    if (undeclared.length > 0) {
        problems.push(
            "These Tauri APIs are imported by a seam but have no entry in DECLARED_CAPABILITY_SURFACE. Add one naming the permission each needs (or an empty list, if it needs none - see the three that do):\n" +
                undeclared
                    .map(({ binding, module, file }) => `  - ${binding} (${module}) in ${file}`)
                    .join("\n")
        );
    }

    // The other direction, so the declaration cannot rot into a list of names nothing imports.
    const importedBindings = new Set(seamBindings.map((entry) => entry.binding));
    const stale = DECLARED_CAPABILITY_SURFACE.filter(
        (entry) => !importedBindings.has(entry.binding)
    );

    if (stale.length > 0) {
        problems.push(
            "These entries in DECLARED_CAPABILITY_SURFACE name an API no seam imports any more. Remove each one, and remove its permission from src-tauri/capabilities/ if nothing else needs it:\n" +
                stale.map(({ binding }) => `  - ${binding}`).join("\n")
        );
    }

    const granted = extractGrantedPermissions(capabilities);

    // What the seam actually uses, so a stale entry's permissions do not count as needed.
    const needed = new Set(
        DECLARED_CAPABILITY_SURFACE.filter((entry) => importedBindings.has(entry.binding)).flatMap(
            (entry) => entry.permissions
        )
    );

    const missing = [...needed].filter((identifier) => !granted.has(identifier)).sort();

    if (missing.length > 0) {
        problems.push(
            "The seam calls an API whose permission is not granted in src-tauri/capabilities/. At runtime the ACL refuses the call, which reaches the user as a feature that silently does nothing:\n" +
                missing.map((identifier) => `  - ${identifier}`).join("\n")
        );
    }

    const unused = [...granted].filter((identifier) => !needed.has(identifier)).sort();

    if (unused.length > 0) {
        problems.push(
            "These permissions are granted but no seam API needs them. A grant nothing calls is surface the renderer holds for free - remove it, or add the entry that explains what uses it:\n" +
                unused.map((identifier) => `  - ${identifier}`).join("\n")
        );
    }

    let manifestNote;

    if (aclManifest) {
        const unknown = [...granted].filter((id) => !permissionExists(id, aclManifest)).sort();

        if (unknown.length > 0) {
            problems.push(
                "These granted identifiers do not name any permission the installed plugins define. A typo here is accepted by the config and refused at runtime:\n" +
                    unknown.map((identifier) => `  - ${identifier}`).join("\n")
            );
        }

        manifestNote = "every granted identifier exists in the ACL manifest";
    } else {
        manifestNote =
            "the ACL manifest was not present (src-tauri/gen/schemas/ is generated by a Tauri build), so identifiers were NOT checked against the permissions the plugins define";
    }

    if (problems.length > 0) {
        return { ok: false, message: problems.join("\n\n") };
    }

    return {
        ok: true,
        message:
            `The capability surface matches: ${importedBindings.size} Tauri APIs across ${seams.length} seam files, ` +
            `${granted.size} granted permissions, none missing and none unused. Note: ${manifestNote}.`,
    };
}

// Only run the gate when invoked as a script, so the exports above stay unit-testable (importing
// this file must not read files or exit).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    const seams = SEAM_FILES.map((relativePath) => ({
        name: relativePath,
        content: readFileSync(join(root, relativePath), "utf8"),
    }));

    const capabilitiesDir = join(root, "src-tauri", "capabilities");
    const capabilities = readdirSync(capabilitiesDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => ({
            name: `src-tauri/capabilities/${name}`,
            content: readFileSync(join(capabilitiesDir, name), "utf8"),
        }));

    const manifestPath = join(root, "src-tauri", "gen", "schemas", "acl-manifests.json");
    const aclManifest = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, "utf8"))
        : null;

    if (process.argv[2] === "--print") {
        for (const { name, content } of seams) {
            for (const { binding, module } of extractTauriBindings(content)) {
                console.log(`${binding}\t${module}\t${name}`);
            }
        }
    } else {
        const result = verifyCapabilitySurface({ seams, capabilities, aclManifest });

        if (result.ok) {
            console.log(result.message);
        } else {
            console.error(result.message);
            process.exit(1);
        }
    }
}
