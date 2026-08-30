import { describe, expect, it } from "vitest";
import {
    extractTauriBindings,
    extractGrantedPermissions,
    permissionExists,
    verifyCapabilitySurface,
    DECLARED_CAPABILITY_SURFACE,
} from "./verify-capability-surface.js";

// A seam pair importing exactly the declared surface, so a passing baseline exists to mutate. Built
// from DECLARED_CAPABILITY_SURFACE rather than hand-written. A test fixture listing the bindings
// separately would be a third inventory, and keeping it in step by hand is the failure this gate
// exists to remove.
function completeSeams() {
    const byModule = new Map();

    for (const { binding, module } of DECLARED_CAPABILITY_SURFACE) {
        byModule.set(module, [...(byModule.get(module) ?? []), binding]);
    }

    const lines = [...byModule].map(
        ([module, bindings]) => `import { ${bindings.join(", ")} } from "${module}";`
    );

    return [
        { name: "src/lib/tauri-client.ts", content: lines.join("\n") },
        { name: "src/lib/tauri-platform.ts", content: "" },
    ];
}

// The permissions the complete seam needs, as one capability file.
function completeCapabilities(overrides) {
    const permissions =
        overrides ??
        [...new Set(DECLARED_CAPABILITY_SURFACE.flatMap((entry) => entry.permissions))];

    return [
        {
            name: "src-tauri/capabilities/default.json",
            content: JSON.stringify({ identifier: "default", permissions }),
        },
    ];
}

const ACL_MANIFEST = {
    "core:app": { permissions: { "allow-version": {} } },
    "core:event": { permissions: { "allow-listen": {}, "allow-unlisten": {} } },
    dialog: { permissions: { "allow-open": {}, "allow-save": {} } },
    opener: { permissions: { "allow-open-url": {} } },
    process: { permissions: { "allow-restart": {} } },
    updater: { permissions: { "allow-check": {} }, default_permission: { permissions: [] } },
};

describe("extractTauriBindings", () => {
    it("reads value bindings from both import and export statements", () => {
        const bindings = extractTauriBindings(
            'import { invoke } from "@tauri-apps/api/core";\n' +
                'export { getVersion } from "@tauri-apps/api/app";'
        );

        expect(bindings).toEqual([
            { binding: "invoke", module: "@tauri-apps/api/core" },
            { binding: "getVersion", module: "@tauri-apps/api/app" },
        ]);
    });

    it("records a renamed binding under its original name", () => {
        // The alias is a readability choice at the seam; the permission is about what the API is.
        // Matching on the alias would let a rename silently move a binding out of the declaration.
        const bindings = extractTauriBindings(
            'export { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";'
        );

        expect(bindings.map((entry) => entry.binding)).toEqual(["open", "save"]);
    });

    it("skips type-only bindings", () => {
        // `type Update` is erased at compile time and calls nothing, so demanding a permission entry
        // for it would demand one for a name that never reaches the ACL.
        const bindings = extractTauriBindings(
            'export { check as checkForAppUpdate, type Update } from "@tauri-apps/plugin-updater";\n' +
                'import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";'
        );

        expect(bindings.map((entry) => entry.binding)).toEqual(["check", "listen"]);
    });

    it("ignores imports from modules that are not @tauri-apps", () => {
        const bindings = extractTauriBindings(
            'import { useState } from "react";\nimport { z } from "zod";'
        );

        expect(bindings).toEqual([]);
    });

    it("reads a statement split across several lines", () => {
        const bindings = extractTauriBindings(
            'import {\n    Channel,\n    invoke,\n} from "@tauri-apps/api/core";'
        );

        expect(bindings.map((entry) => entry.binding)).toEqual(["Channel", "invoke"]);
    });
});

describe("extractGrantedPermissions", () => {
    it("reads both the bare and the scoped grant shapes", () => {
        // A scoped grant (the opener's three YouTube URLs) is an object; only its identifier is the
        // permission. Reading only strings would silently drop it and report it as missing.
        const granted = extractGrantedPermissions([
            {
                name: "default.json",
                content: JSON.stringify({
                    permissions: [
                        "dialog:allow-open",
                        { identifier: "opener:allow-open-url", allow: [{ url: "https://x/*" }] },
                    ],
                }),
            },
        ]);

        expect([...granted].sort()).toEqual(["dialog:allow-open", "opener:allow-open-url"]);
    });

    it("merges the grants of every capability file", () => {
        const granted = extractGrantedPermissions([
            { name: "default.json", content: JSON.stringify({ permissions: ["dialog:allow-open"] }) },
            {
                name: "desktop.json",
                content: JSON.stringify({ permissions: ["process:allow-restart"] }),
            },
        ]);

        expect(granted.size).toBe(2);
    });
});

describe("permissionExists", () => {
    it("resolves a plugin permission and a core one", () => {
        // The split is on the *last* colon, which is what makes `core:app:allow-version` resolve to
        // the `allow-version` permission of the `core:app` plugin rather than to nothing.
        expect(permissionExists("dialog:allow-open", ACL_MANIFEST)).toBe(true);
        expect(permissionExists("core:app:allow-version", ACL_MANIFEST)).toBe(true);
    });

    it("resolves a plugin's default set, which lives outside the permissions map", () => {
        expect(permissionExists("updater:default", ACL_MANIFEST)).toBe(true);
    });

    it("rejects an unknown plugin, an unknown permission and an unqualified name", () => {
        expect(permissionExists("clipboard:allow-write", ACL_MANIFEST)).toBe(false);
        expect(permissionExists("dialog:allow-opne", ACL_MANIFEST)).toBe(false);
        expect(permissionExists("allow-open", ACL_MANIFEST)).toBe(false);
    });
});

describe("verifyCapabilitySurface", () => {
    it("passes when every imported API has its permission and nothing is over-granted", () => {
        const result = verifyCapabilitySurface({
            seams: completeSeams(),
            capabilities: completeCapabilities(),
            aclManifest: ACL_MANIFEST,
        });

        expect(result.ok).toBe(true);
        expect(result.message).toContain("none missing and none unused");
    });

    it("fails when a permission the seam needs is not granted", () => {
        // The failure this gate exists for. At runtime the ACL refuses the call and the feature
        // silently does nothing, on the first click a user makes.
        const permissions = [
            ...new Set(DECLARED_CAPABILITY_SURFACE.flatMap((entry) => entry.permissions)),
        ].filter((identifier) => identifier !== "dialog:allow-save");

        const result = verifyCapabilitySurface({
            seams: completeSeams(),
            capabilities: completeCapabilities(permissions),
            aclManifest: ACL_MANIFEST,
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("dialog:allow-save");
        expect(result.message).toContain("silently does nothing");
    });

    it("fails when a permission is granted that no seam API needs", () => {
        // The over-grant direction, which is not hypothetical. The list was the scaffolded
        // `core:default` (92 individual permissions), through four rounds of capability hardening,
        // because nothing compared it against the two seam files.
        const permissions = [
            ...new Set(DECLARED_CAPABILITY_SURFACE.flatMap((entry) => entry.permissions)),
            "core:window:allow-close",
        ];

        const result = verifyCapabilitySurface({
            seams: completeSeams(),
            capabilities: completeCapabilities(permissions),
            aclManifest: ACL_MANIFEST,
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("core:window:allow-close");
    });

    it("fails when a seam imports an API with no declared entry", () => {
        const seams = completeSeams();
        seams[1].content = 'export { writeText } from "@tauri-apps/plugin-clipboard-manager";';

        const result = verifyCapabilitySurface({
            seams,
            capabilities: completeCapabilities(),
            aclManifest: ACL_MANIFEST,
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("writeText");
        expect(result.message).toContain("DECLARED_CAPABILITY_SURFACE");
    });

    it("fails when a declared entry names an API no seam imports any more", () => {
        // The rot direction. Without it the declaration decays into a list of names nothing calls,
        // which is how the prose version of this rule died next door.
        const seams = completeSeams();
        seams[0].content = seams[0].content.replace(/\brelaunch,?\s*/, "");

        const result = verifyCapabilitySurface({
            seams,
            capabilities: completeCapabilities(),
            aclManifest: ACL_MANIFEST,
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("relaunch");
    });

    it("fails on a granted identifier that names no real permission", () => {
        // A typo is accepted by the config and refused at runtime. It fails twice here (the
        // permission it meant is missing, and the one it spelled does not exist), which is the right
        // amount for a one-character mistake that would otherwise reach a user.
        const permissions = [
            ...new Set(DECLARED_CAPABILITY_SURFACE.flatMap((entry) => entry.permissions)),
        ].map((identifier) => (identifier === "dialog:allow-open" ? "dialog:allow-opne" : identifier));

        const result = verifyCapabilitySurface({
            seams: completeSeams(),
            capabilities: completeCapabilities(permissions),
            aclManifest: ACL_MANIFEST,
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("dialog:allow-opne");
    });

    it("reports the identifier check as skipped when no ACL manifest is available", () => {
        // `src-tauri/gen/schemas/` is generated by a Tauri build and gitignored, so a CI job that
        // never builds the Rust side has no manifest. Saying so is the point. A check that quietly
        // stops checking is the failure this whole file is about.
        const result = verifyCapabilitySurface({
            seams: completeSeams(),
            capabilities: completeCapabilities(),
            aclManifest: null,
        });

        expect(result.ok).toBe(true);
        expect(result.message).toContain("were NOT checked");
    });

    it("refuses an empty seam surface rather than passing vacuously", () => {
        // Every check below the scan is relative to what it found, so a scan that matched nothing
        // would report a perfect surface. That is the shape a moved seam or a changed import style
        // produces, and it must fail rather than congratulate.
        const result = verifyCapabilitySurface({
            seams: [{ name: "src/lib/tauri-client.ts", content: "" }],
            capabilities: completeCapabilities(),
            aclManifest: ACL_MANIFEST,
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain("vacuously");
    });
});
