import { describe, expect, it } from "vitest";
import { avatarInitials, resolveAvatarSrc } from "./avatar";

describe("resolveAvatarSrc", () => {
    it("returns undefined for null or blank values", () => {
        expect(resolveAvatarSrc(null)).toBeUndefined();
        expect(resolveAvatarSrc("")).toBeUndefined();
        expect(resolveAvatarSrc("   ")).toBeUndefined();
    });

    it("returns http and https urls", () => {
        expect(resolveAvatarSrc("https://example.com/avatar.png")).toBe(
            "https://example.com/avatar.png"
        );
        expect(resolveAvatarSrc("http://example.com/avatar.png")).toBe(
            "http://example.com/avatar.png"
        );
    });

    it("matches the scheme case-insensitively", () => {
        expect(resolveAvatarSrc("HTTPS://EXAMPLE.COM/AVATAR.PNG")).toBe(
            "HTTPS://EXAMPLE.COM/AVATAR.PNG"
        );
    });

    it("trims surrounding whitespace before validating", () => {
        expect(resolveAvatarSrc("  https://example.com/avatar.png  ")).toBe(
            "https://example.com/avatar.png"
        );
    });

    it("returns undefined for non-remote values", () => {
        expect(resolveAvatarSrc("avatar.png")).toBeUndefined();
        expect(resolveAvatarSrc("C:/avatars/avatar.png")).toBeUndefined();
    });

    it("requires the scheme at the start of the value", () => {
        expect(resolveAvatarSrc("see https://example.com/avatar.png")).toBeUndefined();
    });
});

describe("avatarInitials", () => {
    it("builds two uppercase letters from the name", () => {
        expect(avatarInitials("john")).toBe("JO");
    });

    it("strips every leading @ before building initials", () => {
        expect(avatarInitials("@john")).toBe("JO");
        expect(avatarInitials("@@john")).toBe("JO");
    });

    it("only strips @ at the start of the name", () => {
        expect(avatarInitials("j@ohn")).toBe("J@");
    });

    it("trims whitespace before slicing the initials", () => {
        expect(avatarInitials("  jo  ")).toBe("JO");
        expect(avatarInitials("@ jo")).toBe("JO");
    });

    it("falls back to ? when nothing remains", () => {
        expect(avatarInitials("")).toBe("?");
        expect(avatarInitials("   ")).toBe("?");
        expect(avatarInitials("@@")).toBe("?");
    });

    it("keeps a single-character name as-is", () => {
        expect(avatarInitials("j")).toBe("J");
    });
});
