import { describe, expect, it } from "vitest";
import { pnpmInvocation } from "./pnpm-invocation.js";

describe("pnpmInvocation", () => {
    it("starts pnpm directly, without a shell, outside Windows", () => {
        expect(pnpmInvocation(["licenses", "list", "--prod", "--json"], "linux")).toEqual({
            file: "pnpm",
            args: ["licenses", "list", "--prod", "--json"],
            shell: false,
        });
    });

    it("builds the command line itself on Windows, so no argv array goes through the shell", () => {
        expect(pnpmInvocation(["licenses", "list", "--dev", "--json"], "win32")).toEqual({
            file: "pnpm licenses list --dev --json",
            args: [],
            shell: true,
        });
    });

    it("refuses an argument the shell would read as more than text", () => {
        for (const arg of ["a b", "x&calc", "$(id)", '"quoted"', "a|b", ""]) {
            expect(() => pnpmInvocation(["install", arg], "win32")).toThrow(/refusing/);
        }
    });
});
