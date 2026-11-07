import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiagnosticsPhysicalIntegritySection } from "./diagnostics-physical-integrity-section";
import { renderWithMantine } from "../../../test/test-utils";
import type { LibraryIntegrityReport } from "../../../types/diagnostics";

// The deep check at the foot of the section starts a backend run and is covered on its own.
vi.mock("./diagnostics-content-verification", () => ({
    DiagnosticsContentVerification: () => null,
}));

function report(overrides: Partial<LibraryIntegrityReport> = {}): LibraryIntegrityReport {
    return {
        checked_media_files: 0,
        missing_media_files: 0,
        missing_media_examples: [],
        corrupt_media_files: 0,
        corrupt_media_examples: [],
        checked_thumbnail_files: 0,
        missing_thumbnail_files: 0,
        missing_thumbnail_examples: [],
        corrupt_thumbnail_files: 0,
        corrupt_thumbnail_examples: [],
        orphan_media_files: 0,
        orphan_media_examples: [],
        orphan_thumbnail_files: 0,
        orphan_thumbnail_examples: [],
        invalid_media_files: 0,
        invalid_media_examples: [],
        invalid_thumbnail_files: 0,
        invalid_thumbnail_examples: [],
        checked_live_chat_files: 0,
        missing_live_chat_files: 0,
        missing_live_chat_examples: [],
        corrupt_live_chat_files: 0,
        corrupt_live_chat_examples: [],
        orphan_live_chat_files: 0,
        orphan_live_chat_examples: [],
        invalid_live_chat_files: 0,
        invalid_live_chat_examples: [],
        ...overrides,
    };
}

describe("DiagnosticsPhysicalIntegritySection", () => {
    it("lists the live chat replays the invalid path issue counts", () => {
        // The issue above the section adds them up with the media and thumbnail ones, so a
        // section without them named fewer paths than the issue said.
        renderWithMantine(
            <DiagnosticsPhysicalIntegritySection
                libraryPath="/library"
                libraryIntegrity={report({
                    invalid_live_chat_files: 1,
                    invalid_live_chat_examples: ["../outside/chat.json"],
                    missing_live_chat_files: 2,
                    missing_live_chat_examples: ["live_chat/gone.json.gz"],
                })}
            />
        );

        expect(screen.getByText("Invalid live chat paths")).toBeInTheDocument();
        expect(screen.getByText("../outside/chat.json")).toBeInTheDocument();
        expect(screen.getByText("Missing live chats")).toBeInTheDocument();
        expect(screen.getByText("live_chat/gone.json.gz")).toBeInTheDocument();
    });
});
