import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExternalToolsWarning } from "./external-tools-warning";
import { renderWithMantine } from "../../../test/test-utils";

describe("ExternalToolsWarning", () => {
    it("renders nothing when every tool the import needs is available", () => {
        renderWithMantine(<ExternalToolsWarning missingTools={[]} />);

        // The common case, and the form must not carry an empty slot for it.
        expect(screen.queryByText(/was not found|were not found/)).not.toBeInTheDocument();
        expect(screen.queryByText(/tools folder/)).not.toBeInTheDocument();
    });

    it("names the missing tool and what it is for", () => {
        renderWithMantine(<ExternalToolsWarning missingTools={["yt-dlp"]} />);

        expect(screen.getByText("yt-dlp was not found")).toBeInTheDocument();
        expect(screen.getByText(/downloads the media from the URL/)).toBeInTheDocument();
        expect(screen.getByText(/tools folder/)).toBeInTheDocument();
    });

    it("reads as a plural when both are missing", () => {
        renderWithMantine(<ExternalToolsWarning missingTools={["yt-dlp", "ffmpeg"]} />);

        expect(screen.getByText("yt-dlp and ffmpeg were not found")).toBeInTheDocument();
        expect(screen.getByText(/Install them/)).toBeInTheDocument();
    });
});
