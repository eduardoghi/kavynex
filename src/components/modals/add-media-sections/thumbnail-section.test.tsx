import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThumbnailSection } from "./thumbnail-section";
import { renderWithMantine } from "../../../test/test-utils";

vi.mock("../../../utils/media-utils", async () => {
    const actual = await vi.importActual<typeof import("../../../utils/media-utils")>(
        "../../../utils/media-utils"
    );

    return {
        ...actual,
        fileSrcFromPath: vi.fn((path: string | null) => (path ? `file://${path}` : "")),
    };
});

describe("ThumbnailSection", () => {
    it("shows blocked state when thumbnail cannot be selected yet", () => {
        renderWithMantine(
            <ThumbnailSection
                thumbPath=""
                mediaType="video"
                isGeneratingThumb={false}
                isBusy={false}
                canSelectThumb={false}
                isUrlMode={false}
                onPickThumb={vi.fn()}
            />
        );

        expect(screen.getByText("Select a media file first")).toBeInTheDocument();
        expect(screen.getByText("blocked")).toBeInTheDocument();
    });

    it("shows selected state when thumbnail exists", () => {
        renderWithMantine(
            <ThumbnailSection
                thumbPath="/tmp/thumb.jpg"
                mediaType="video"
                isGeneratingThumb={false}
                isBusy={false}
                canSelectThumb
                isUrlMode={false}
                onPickThumb={vi.fn()}
            />
        );

        expect(screen.getByText("Thumbnail selected")).toBeInTheDocument();
        expect(screen.getByText("selected")).toBeInTheDocument();
    });

    it("shows loading state while generating thumbnail", () => {
        renderWithMantine(
            <ThumbnailSection
                thumbPath=""
                mediaType="video"
                isGeneratingThumb
                isBusy
                canSelectThumb
                isUrlMode={false}
                onPickThumb={vi.fn()}
            />
        );

        expect(screen.getByText("Generating automatic thumbnail...")).toBeInTheDocument();
        expect(screen.getByText("loading")).toBeInTheDocument();
    });

    it("shows audio help text for audio media", () => {
        renderWithMantine(
            <ThumbnailSection
                thumbPath=""
                mediaType="audio"
                isGeneratingThumb={false}
                isBusy={false}
                canSelectThumb
                isUrlMode={false}
                onPickThumb={vi.fn()}
            />
        );

        expect(
            screen.getByText(
                "For audio, if you don’t choose an image, it will show an audio icon"
            )
        ).toBeInTheDocument();
    });

    it("calls pick handler on click when allowed", () => {
        const onPickThumb = vi.fn();

        renderWithMantine(
            <ThumbnailSection
                thumbPath=""
                mediaType="video"
                isGeneratingThumb={false}
                isBusy={false}
                canSelectThumb
                isUrlMode={false}
                onPickThumb={onPickThumb}
            />
        );

        fireEvent.click(screen.getByText("Click to choose an image for thumbnail (optional)"));
        expect(onPickThumb).toHaveBeenCalled();
    });

    it("calls pick handler on Enter when allowed", () => {
        const onPickThumb = vi.fn();

        renderWithMantine(
            <ThumbnailSection
                thumbPath=""
                mediaType="video"
                isGeneratingThumb={false}
                isBusy={false}
                canSelectThumb
                isUrlMode={false}
                onPickThumb={onPickThumb}
            />
        );

        fireEvent.keyDown(screen.getByRole("button"), {
            key: "Enter",
        });

        expect(onPickThumb).toHaveBeenCalledTimes(1);
    });

    it("does not call pick handler when blocked", () => {
        const onPickThumb = vi.fn();

        renderWithMantine(
            <ThumbnailSection
                thumbPath=""
                mediaType="video"
                isGeneratingThumb={false}
                isBusy={false}
                canSelectThumb={false}
                isUrlMode={false}
                onPickThumb={onPickThumb}
            />
        );

        fireEvent.click(screen.getByText("Select a media file first"));
        expect(onPickThumb).not.toHaveBeenCalled();
    });
});