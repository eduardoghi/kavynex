import { describe, expect, it } from "vitest";
import { isFilesystemRootPath, normalizeNonEmptyUniquePaths } from "./paths";

describe("normalizeNonEmptyUniquePaths", () => {
    it("trims values and drops empty/whitespace-only ones", () => {
        expect(normalizeNonEmptyUniquePaths([" a ", "", "  ", "b"])).toEqual(["a", "b"]);
    });

    it("drops null and undefined", () => {
        expect(normalizeNonEmptyUniquePaths(["a", null, undefined, "b"])).toEqual(["a", "b"]);
    });

    it("de-duplicates while preserving first-seen order", () => {
        expect(normalizeNonEmptyUniquePaths(["b", "a", " b ", "a"])).toEqual(["b", "a"]);
    });

    it("returns an empty array for no usable values", () => {
        expect(normalizeNonEmptyUniquePaths([null, "", "   ", undefined])).toEqual([]);
    });
});

describe("isFilesystemRootPath", () => {
    it("recognizes a POSIX root", () => {
        expect(isFilesystemRootPath("/")).toBe(true);
    });

    it("recognizes a Windows drive root with a trailing backslash", () => {
        expect(isFilesystemRootPath("C:\\")).toBe(true);
    });

    it("recognizes a Windows drive root without a trailing backslash", () => {
        expect(isFilesystemRootPath("D:")).toBe(true);
    });

    it("recognizes an extended-length Windows drive root", () => {
        expect(isFilesystemRootPath("\\\\?\\C:\\")).toBe(true);
    });

    it("recognizes a UNC share root", () => {
        expect(isFilesystemRootPath("\\\\server\\share")).toBe(true);
    });

    it("recognizes a UNC share root with a trailing backslash", () => {
        expect(isFilesystemRootPath("\\\\server\\share\\")).toBe(true);
    });

    it("rejects a normal Windows folder", () => {
        expect(isFilesystemRootPath("C:\\Users\\bob\\Library")).toBe(false);
    });

    it("rejects a normal POSIX folder", () => {
        expect(isFilesystemRootPath("/home/bob/library")).toBe(false);
    });

    it("rejects a UNC path with a folder under the share", () => {
        expect(isFilesystemRootPath("\\\\server\\share\\library")).toBe(false);
    });

    it("returns false for an empty or whitespace-only value", () => {
        expect(isFilesystemRootPath("")).toBe(false);
        expect(isFilesystemRootPath("   ")).toBe(false);
    });
});
