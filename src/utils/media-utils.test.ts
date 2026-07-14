import { describe, expect, it, vi } from "vitest";
import { convertFileSrc } from "../lib/tauri-platform";
import {
    extensionFromPath,
    fileNameFromPath,
    fileSrcFromAbsolutePath,
    fileSrcFromPath,
    fileSrcFromStoredPath,
    formatBytes,
    formatCreatedAt,
    formatDuration,
    formatPublishedDate,
    initials,
    isThumbnailFile,
    joinNormalizedPath,
    mediaTypeFromFile,
    resolveStoredPath,
    shortPath,
    stripWindowsExtendedPrefix,
} from "./media-utils";

vi.mock("../lib/tauri-platform", () => ({
    convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

const convertFileSrcMock = vi.mocked(convertFileSrc);

// Some ICU versions emit a narrow no-break space (U+202F) before AM/PM markers.
function normalizeSpaces(value: string): string {
    return value.replace(/\u202f/g, " ");
}

describe("media-utils", () => {
    describe("stripWindowsExtendedPrefix", () => {
        it("strips the extended-length prefix from a drive path", () => {
            expect(stripWindowsExtendedPrefix("\\\\?\\C:\\Users\\video.mp4")).toBe(
                "C:\\Users\\video.mp4"
            );
        });

        it("strips the slash-normalized extended-length prefix", () => {
            expect(stripWindowsExtendedPrefix("//?/C:/Users/video.mp4")).toBe(
                "C:/Users/video.mp4"
            );
        });

        it("converts the UNC extended-length prefix back to a UNC path", () => {
            expect(stripWindowsExtendedPrefix("\\\\?\\UNC\\server\\share\\file.mp4")).toBe(
                "\\\\server\\share\\file.mp4"
            );
        });

        it("converts the slash-normalized UNC prefix back to a UNC path", () => {
            expect(stripWindowsExtendedPrefix("//?/UNC/server/share/file.mp4")).toBe(
                "\\\\server/share/file.mp4"
            );
        });

        it("matches the UNC marker case-insensitively", () => {
            expect(stripWindowsExtendedPrefix("\\\\?\\unc\\server\\share")).toBe(
                "\\\\server\\share"
            );
        });

        it("keeps regular paths untouched", () => {
            expect(stripWindowsExtendedPrefix("C:\\Users\\video.mp4")).toBe(
                "C:\\Users\\video.mp4"
            );
            expect(stripWindowsExtendedPrefix("/home/user/video.mp4")).toBe(
                "/home/user/video.mp4"
            );
        });

        it("does not strip a single-slash question mark prefix", () => {
            expect(stripWindowsExtendedPrefix("\\?\\C:\\Users\\video.mp4")).toBe(
                "\\?\\C:\\Users\\video.mp4"
            );
        });

        it("only strips the prefix at the start of the path", () => {
            expect(stripWindowsExtendedPrefix("C:\\data\\\\?\\C:\\other")).toBe(
                "C:\\data\\\\?\\C:\\other"
            );
            expect(stripWindowsExtendedPrefix("C:\\data\\\\?\\UNC\\server\\share")).toBe(
                "C:\\data\\\\?\\UNC\\server\\share"
            );
        });
    });

    describe("fileNameFromPath", () => {
        it("returns the last segment of a path", () => {
            expect(fileNameFromPath("C:\\media\\clips\\video.mp4")).toBe("video.mp4");
            expect(fileNameFromPath("/media/music/song.mp3")).toBe("song.mp3");
        });

        it("trims surrounding whitespace before extracting", () => {
            expect(fileNameFromPath("  /media/song.mp3  ")).toBe("song.mp3");
        });

        it("ignores trailing slashes", () => {
            expect(fileNameFromPath("/media/videos/")).toBe("videos");
        });

        it("returns an empty string for empty or slash-only paths", () => {
            expect(fileNameFromPath("")).toBe("");
            expect(fileNameFromPath("   ")).toBe("");
            expect(fileNameFromPath("///")).toBe("");
        });
    });

    describe("extensionFromPath", () => {
        it("extracts file extension correctly", () => {
            expect(extensionFromPath("/tmp/test.webm")).toBe("webm");
            expect(extensionFromPath("/tmp/noext")).toBe("");
        });

        it("lowercases the extension", () => {
            expect(extensionFromPath("/tmp/VIDEO.MP4")).toBe("mp4");
        });

        it("uses the last dot for multi-dot file names", () => {
            expect(extensionFromPath("/tmp/archive.tar.gz")).toBe("gz");
        });

        it("returns an empty string for a trailing dot", () => {
            expect(extensionFromPath("/tmp/file.")).toBe("");
        });

        it("treats a leading dot as an extension separator", () => {
            expect(extensionFromPath("/tmp/.env")).toBe("env");
        });

        it("trims whitespace around the extension", () => {
            expect(extensionFromPath("dir/video.MP4 /")).toBe("mp4");
        });
    });

    describe("mediaTypeFromFile", () => {
        it("detects audio media type from file extension", () => {
            expect(mediaTypeFromFile("C:/media/music.mp3")).toBe("audio");
            expect(mediaTypeFromFile("C:/media/video.mp4")).toBe("video");
        });

        it("classifies every known audio extension as audio", () => {
            const audioExtensions = [
                "mp3",
                "m4a",
                "aac",
                "wav",
                "flac",
                "ogg",
                "opus",
                "wma",
                "alac",
                "aiff",
            ];

            for (const ext of audioExtensions) {
                expect(mediaTypeFromFile(`C:/media/track.${ext}`)).toBe("audio");
            }
        });

        it("matches audio extensions case-insensitively", () => {
            expect(mediaTypeFromFile("C:/media/SONG.FLAC")).toBe("audio");
        });

        it("defaults to video for unknown or missing extensions", () => {
            expect(mediaTypeFromFile("C:/media/clip.mkv")).toBe("video");
            expect(mediaTypeFromFile("C:/media/noext")).toBe("video");
        });
    });

    describe("isThumbnailFile", () => {
        it("recognizes every thumbnail extension", () => {
            const thumbnailExtensions = ["png", "jpg", "jpeg", "webp", "bmp", "avif"];

            for (const ext of thumbnailExtensions) {
                expect(isThumbnailFile(`C:/media/thumb.${ext}`)).toBe(true);
            }
        });

        it("rejects non-thumbnail files", () => {
            expect(isThumbnailFile("C:/media/thumb.gif")).toBe(false);
            expect(isThumbnailFile("C:/media/video.mp4")).toBe(false);
            expect(isThumbnailFile("C:/media/noext")).toBe(false);
        });
    });

    describe("joinNormalizedPath", () => {
        it("joins base and relative paths with a single separator", () => {
            expect(joinNormalizedPath("/base", "video/a.mp4")).toBe("/base/video/a.mp4");
            expect(joinNormalizedPath("C:\\base\\", "sub\\a.mp4")).toBe("C:/base/sub/a.mp4");
        });

        it("collapses repeated slashes at the boundary", () => {
            expect(joinNormalizedPath("/base///", "///a.mp4")).toBe("/base/a.mp4");
        });

        it("trims whitespace on both sides", () => {
            expect(joinNormalizedPath("  /base  ", "  rel  ")).toBe("/base/rel");
        });

        it("returns the other side when one side is empty", () => {
            expect(joinNormalizedPath("", "a/b")).toBe("a/b");
            expect(joinNormalizedPath("/base", "")).toBe("/base");
            expect(joinNormalizedPath("", "")).toBe("");
        });
    });

    describe("fileSrcFromPath", () => {
        it("returns null for null, empty or whitespace-only paths", () => {
            expect(fileSrcFromPath(null)).toBeNull();
            expect(fileSrcFromPath("")).toBeNull();
            expect(fileSrcFromPath("   ")).toBeNull();
        });

        it("converts a trimmed, slash-normalized path", () => {
            expect(fileSrcFromPath("  C:\\media\\video.mp4  ")).toBe(
                "asset://localhost/C:/media/video.mp4"
            );
            expect(convertFileSrcMock).toHaveBeenCalledWith("C:/media/video.mp4");
        });

        it("strips the Windows extended-length prefix before converting", () => {
            fileSrcFromPath("\\\\?\\C:\\media\\video.mp4");
            expect(convertFileSrcMock).toHaveBeenCalledWith("C:/media/video.mp4");
        });
    });

    describe("initials", () => {
        it("builds uppercase initials from the first two words", () => {
            expect(initials("john doe")).toBe("JD");
            expect(initials("ana beatriz carvalho")).toBe("AB");
        });

        it("uses a single initial for one-word values", () => {
            expect(initials("madonna")).toBe("M");
        });

        it("collapses repeated whitespace between words", () => {
            expect(initials("  john    doe  ")).toBe("JD");
        });

        it("falls back to a question mark for empty values", () => {
            expect(initials("")).toBe("?");
            expect(initials("   ")).toBe("?");
        });
    });

    describe("resolveStoredPath", () => {
        it("resolves relative stored path against library path", () => {
            expect(resolveStoredPath("video/media_abc.mp4", "/library/base")).toBe(
                "/library/base/video/media_abc.mp4"
            );
        });

        it("keeps absolute stored path as absolute", () => {
            expect(resolveStoredPath("C:\\library\\video\\file.mp4", "/library/base")).toBe(
                "C:/library/video/file.mp4"
            );
        });

        it("keeps unix-style absolute stored path as absolute", () => {
            expect(resolveStoredPath("/unix/media.mp4", "/library/base")).toBe(
                "/unix/media.mp4"
            );
        });

        it("trims the stored path before deciding whether it is absolute", () => {
            expect(resolveStoredPath("  C:\\media\\a.mp4  ", "/library/base")).toBe(
                "C:/media/a.mp4"
            );
        });

        it("only treats a drive prefix at the start as absolute", () => {
            expect(resolveStoredPath("nested/c:/odd.mp4", "/library/base")).toBe(
                "/library/base/nested/c:/odd.mp4"
            );
        });

        it("returns null for empty stored path", () => {
            expect(resolveStoredPath("", "/library/base")).toBeNull();
            expect(resolveStoredPath(null, "/library/base")).toBeNull();
            expect(resolveStoredPath("   ", "/library/base")).toBeNull();
        });
    });

    describe("fileSrcFromAbsolutePath", () => {
        it("returns an empty string for null, empty or whitespace-only paths", () => {
            expect(fileSrcFromAbsolutePath(null)).toBe("");
            expect(fileSrcFromAbsolutePath("")).toBe("");
            expect(fileSrcFromAbsolutePath("   ")).toBe("");
        });

        it("converts a trimmed, slash-normalized path", () => {
            expect(fileSrcFromAbsolutePath("  C:\\a\\b.mp4  ")).toBe(
                "asset://localhost/C:/a/b.mp4"
            );
            expect(convertFileSrcMock).toHaveBeenCalledWith("C:/a/b.mp4");
        });

        it("strips the UNC extended-length prefix before converting", () => {
            fileSrcFromAbsolutePath("\\\\?\\UNC\\server\\share\\a.mp4");
            expect(convertFileSrcMock).toHaveBeenCalledWith("//server/share/a.mp4");
        });
    });

    describe("fileSrcFromStoredPath", () => {
        it("resolves relative stored paths before converting", () => {
            expect(fileSrcFromStoredPath("video/a.mp4", "/library/base")).toBe(
                "asset://localhost//library/base/video/a.mp4"
            );
        });

        it("returns an empty string for empty stored paths", () => {
            expect(fileSrcFromStoredPath(null, "/library/base")).toBe("");
        });
    });

    describe("formatBytes", () => {
        it("reports unknown size for null, undefined and NaN", () => {
            expect(formatBytes(null)).toBe("size unknown");
            expect(formatBytes(undefined)).toBe("size unknown");
            expect(formatBytes(Number.NaN)).toBe("size unknown");
        });

        it("formats values below 1024 as bytes", () => {
            expect(formatBytes(0)).toBe("0 B");
            expect(formatBytes(512)).toBe("512 B");
            expect(formatBytes(1023)).toBe("1023 B");
        });

        it("formats kilobytes starting exactly at 1024", () => {
            expect(formatBytes(1024)).toBe("1.00 KB");
            expect(formatBytes(1536)).toBe("1.50 KB");
        });

        it("formats megabytes starting exactly at 1024 KB", () => {
            expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
            expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 MB");
        });

        it("formats gigabytes starting exactly at 1024 MB", () => {
            expect(formatBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
            expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
        });
    });

    describe("formatDuration", () => {
        it("returns an empty string for null, undefined, non-finite and non-positive values", () => {
            expect(formatDuration(null)).toBe("");
            expect(formatDuration(undefined)).toBe("");
            expect(formatDuration(0)).toBe("");
            expect(formatDuration(-5)).toBe("");
            expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
            expect(formatDuration(Number.NaN)).toBe("");
        });

        it("formats durations under an hour as m:ss", () => {
            expect(formatDuration(5)).toBe("0:05");
            expect(formatDuration(65)).toBe("1:05");
            expect(formatDuration(600)).toBe("10:00");
        });

        it("formats durations of an hour or more as h:mm:ss", () => {
            expect(formatDuration(3600)).toBe("1:00:00");
            expect(formatDuration(3661)).toBe("1:01:01");
            expect(formatDuration(37325)).toBe("10:22:05");
        });

        it("floors fractional seconds", () => {
            expect(formatDuration(65.9)).toBe("1:05");
        });
    });

    describe("formatPublishedDate", () => {
        it("returns an empty string for null, undefined and blank values", () => {
            expect(formatPublishedDate(null)).toBe("");
            expect(formatPublishedDate(undefined)).toBe("");
            expect(formatPublishedDate("")).toBe("");
            expect(formatPublishedDate("   ")).toBe("");
        });

        it("formats ISO date-only values as local dates", () => {
            expect(formatPublishedDate("2024-03-05")).toBe("Mar 5, 2024");
        });

        it("formats BR date-only values with day before month", () => {
            expect(formatPublishedDate("05/03/2024")).toBe("Mar 5, 2024");
            expect(formatPublishedDate("31/12/2024")).toBe("Dec 31, 2024");
        });

        it("trims date-only values before parsing", () => {
            expect(formatPublishedDate(" 05/03/2024 ")).toBe("Mar 5, 2024");
        });

        it("requires date-only patterns to span the whole value", () => {
            expect(formatPublishedDate("x2024-03-05")).toBe("x2024-03-05");
            expect(formatPublishedDate("2024-03-05extra")).toBe("2024-03-05extra");
            expect(formatPublishedDate("x05/03/2024")).toBe("x05/03/2024");
            expect(formatPublishedDate("05/03/2024extra")).toBe("05/03/2024extra");
        });

        it("formats full datetime values", () => {
            expect(formatPublishedDate("2024-03-05T12:00:00")).toBe("Mar 5, 2024");
        });

        it("returns unparseable values unchanged", () => {
            expect(formatPublishedDate("not a date")).toBe("not a date");
        });
    });

    describe("formatCreatedAt", () => {
        it("returns an empty string for null and blank values", () => {
            expect(formatCreatedAt(null)).toBe("");
            expect(formatCreatedAt("")).toBe("");
            expect(formatCreatedAt("   ")).toBe("");
        });

        it("formats space-separated datetimes with date and time", () => {
            expect(normalizeSpaces(formatCreatedAt("2024-03-05 14:30:00"))).toBe(
                "Mar 5, 2024, 2:30 PM"
            );
        });

        it("formats ISO datetimes with date and time", () => {
            expect(normalizeSpaces(formatCreatedAt("2024-03-05T09:05:00"))).toBe(
                "Mar 5, 2024, 9:05 AM"
            );
        });

        it("trims the value before parsing", () => {
            expect(normalizeSpaces(formatCreatedAt("  2024-03-05 14:30:00  "))).toBe(
                "Mar 5, 2024, 2:30 PM"
            );
        });

        it("returns unparseable values unchanged", () => {
            expect(formatCreatedAt("invalid-date")).toBe("invalid-date");
        });
    });

    describe("shortPath", () => {
        it("returns short paths normalized and trimmed", () => {
            expect(shortPath("  C:\\media\\video.mp4  ")).toBe("C:/media/video.mp4");
        });

        it("returns an empty string for blank values", () => {
            expect(shortPath("")).toBe("");
            expect(shortPath("   ")).toBe("");
        });

        it("keeps a path exactly at the maximum length untouched", () => {
            const path = `C:/${"a".repeat(53)}.mp4`;

            expect(path).toHaveLength(60);
            expect(shortPath(path)).toBe(path);
        });

        it("truncates long paths keeping the start and the file name", () => {
            const path = `C:/${"d".repeat(70)}/file.mp4`;

            expect(shortPath(path)).toBe(`C:/${"d".repeat(45)}.../file.mp4`);
        });

        it("keeps only the file name when it barely fits the limit", () => {
            const fileName = `${"e".repeat(54)}.mp4`;
            const path = `C:/${fileName}`;

            expect(path.length).toBeGreaterThan(60);
            expect(shortPath(path)).toBe(`.../${fileName}`);
        });
    });
});
