import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/media-repository", () => ({
    listMediaIntegrityReferences: vi.fn(),
}));

vi.mock("./live-chat-service", () => ({
    listLiveChatFiles: vi.fn(),
}));

import { listMediaIntegrityReferences } from "../repositories/media-repository";
import { listLiveChatFiles } from "./live-chat-service";
import { getLiveChatIntegrity } from "./diagnostics-live-chat-integrity";
import type { MediaIntegrityReference } from "../types/diagnostics";

const listMediaIntegrityReferencesMock = vi.mocked(listMediaIntegrityReferences);
const listLiveChatFilesMock = vi.mocked(listLiveChatFiles);

function mediaRef(overrides: Partial<MediaIntegrityReference> = {}): MediaIntegrityReference {
    return {
        id: 1,
        channel_id: 10,
        title: "Video",
        file_path: "video/a.mp4",
        thumbnail_path: null,
        live_chat_file_path: null,
        ...overrides,
    };
}

describe("getLiveChatIntegrity", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns an empty report when nothing is expected and nothing is on disk", async () => {
        listMediaIntegrityReferencesMock.mockResolvedValueOnce([
            mediaRef({ live_chat_file_path: null }),
        ]);
        listLiveChatFilesMock.mockResolvedValueOnce([]);

        const report = await getLiveChatIntegrity();

        expect(report).toEqual({
            checked_live_chat_files: 0,
            missing_live_chat_files: 0,
            missing_live_chat_examples: [],
            orphan_live_chat_files: 0,
            orphan_live_chat_examples: [],
        });
    });

    it("reports a live chat file a media row expects but disk does not have as missing", async () => {
        listMediaIntegrityReferencesMock.mockResolvedValueOnce([
            mediaRef({ id: 1, live_chat_file_path: "live_chat/a.json.gz" }),
            mediaRef({ id: 2, live_chat_file_path: "live_chat/b.json.gz" }),
        ]);
        listLiveChatFilesMock.mockResolvedValueOnce(["live_chat/a.json.gz"]);

        const report = await getLiveChatIntegrity();

        expect(report.checked_live_chat_files).toBe(2);
        expect(report.missing_live_chat_files).toBe(1);
        expect(report.missing_live_chat_examples).toEqual(["live_chat/b.json.gz"]);
        expect(report.orphan_live_chat_files).toBe(0);
        expect(report.orphan_live_chat_examples).toEqual([]);
    });

    it("reports a live chat file on disk that no media row references as an orphan", async () => {
        listMediaIntegrityReferencesMock.mockResolvedValueOnce([
            mediaRef({ live_chat_file_path: "live_chat/a.json.gz" }),
        ]);
        listLiveChatFilesMock.mockResolvedValueOnce([
            "live_chat/a.json.gz",
            "live_chat/stray.json.gz",
        ]);

        const report = await getLiveChatIntegrity();

        expect(report.checked_live_chat_files).toBe(1);
        expect(report.missing_live_chat_files).toBe(0);
        expect(report.orphan_live_chat_files).toBe(1);
        expect(report.orphan_live_chat_examples).toEqual(["live_chat/stray.json.gz"]);
    });

    it("trims, de-duplicates and ignores blank paths when building the expected set", async () => {
        listMediaIntegrityReferencesMock.mockResolvedValueOnce([
            mediaRef({ id: 1, live_chat_file_path: "  live_chat/a.json.gz  " }),
            mediaRef({ id: 2, live_chat_file_path: "live_chat/a.json.gz" }),
            mediaRef({ id: 3, live_chat_file_path: "   " }),
            mediaRef({ id: 4, live_chat_file_path: null }),
        ]);
        listLiveChatFilesMock.mockResolvedValueOnce(["live_chat/a.json.gz"]);

        const report = await getLiveChatIntegrity();

        // The whitespace-padded and duplicate entries collapse to one path; the blank and null are
        // dropped, so the single real file is present with nothing missing or orphaned.
        expect(report.checked_live_chat_files).toBe(1);
        expect(report.missing_live_chat_files).toBe(0);
        expect(report.orphan_live_chat_files).toBe(0);
    });

    it("caps both example lists at ten while still counting every entry", async () => {
        const expected = Array.from({ length: 12 }, (_, index) =>
            mediaRef({ id: index + 1, live_chat_file_path: `live_chat/exp${index}.json.gz` })
        );
        const orphansOnDisk = Array.from(
            { length: 12 },
            (_, index) => `live_chat/orph${index}.json.gz`
        );

        listMediaIntegrityReferencesMock.mockResolvedValueOnce(expected);
        listLiveChatFilesMock.mockResolvedValueOnce(orphansOnDisk);

        const report = await getLiveChatIntegrity();

        expect(report.checked_live_chat_files).toBe(12);
        expect(report.missing_live_chat_files).toBe(12);
        expect(report.missing_live_chat_examples).toHaveLength(10);
        expect(report.orphan_live_chat_files).toBe(12);
        expect(report.orphan_live_chat_examples).toHaveLength(10);
    });
});
