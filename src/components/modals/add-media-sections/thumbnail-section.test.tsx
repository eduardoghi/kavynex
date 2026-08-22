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
        // The heading says to pick a media file first and the body says why, so the badge
        // was a third way of saying it. The state itself is unchanged.
        expect(screen.queryByText("blocked")).not.toBeInTheDocument();
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

        // The real file name, like the media picker above it. "Thumbnail selected" said only
        // that something was picked, which the preview beside it already shows.
        expect(screen.getByText("thumb.jpg")).toBeInTheDocument();
        expect(screen.getByText("Click to change thumbnail")).toBeInTheDocument();
        expect(screen.getByAltText("Thumbnail preview")).toHaveAttribute(
            "src",
            "file:///tmp/thumb.jpg"
        );
        expect(screen.queryByText("selected")).not.toBeInTheDocument();
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

        fireEvent.click(screen.getByText("Choose thumbnail"));

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