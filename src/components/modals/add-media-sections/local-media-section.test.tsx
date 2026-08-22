import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocalMediaSection } from "./local-media-section";
import { renderWithMantine } from "../../../test/test-utils";

describe("LocalMediaSection", () => {
    it("shows empty state when no media is selected", () => {
        renderWithMantine(
            <LocalMediaSection
                mediaPath=""
                mediaType="video"
                isLocked={false}
                onPickMedia={vi.fn()}
            />
        );

        expect(screen.getByText("Choose a video/audio file to import")).toBeInTheDocument();
        expect(screen.getByText("Click to choose a file")).toBeInTheDocument();
        // The badge only names the kind of file once one is picked. Empty is what the two
        // lines above already say.
        expect(screen.queryByText("empty")).not.toBeInTheDocument();
    });

    it("shows selected file state", () => {
        renderWithMantine(
            <LocalMediaSection
                mediaPath="/tmp/video.mp4"
                mediaType="video"
                isLocked={false}
                onPickMedia={vi.fn()}
            />
        );

        expect(screen.getByText("video.mp4")).toBeInTheDocument();
        expect(screen.getByText("Click to change file")).toBeInTheDocument();
        // The type is the same glyph the library cards use, so the name is the only way to
        // read it. A word in a chip would have passed a getByText either way.
        expect(screen.getByRole("img", { name: "Video" })).toBeInTheDocument();
        expect(screen.queryByText("video")).not.toBeInTheDocument();
    });

    it("shows audio badge for audio media", () => {
        renderWithMantine(
            <LocalMediaSection
                mediaPath="/tmp/audio.mp3"
                mediaType="audio"
                isLocked={false}
                onPickMedia={vi.fn()}
            />
        );

        expect(screen.getByRole("img", { name: "Audio" })).toBeInTheDocument();
        expect(screen.queryByText("audio")).not.toBeInTheDocument();
    });

    it("calls pick handler on click when unlocked", () => {
        const onPickMedia = vi.fn();

        renderWithMantine(
            <LocalMediaSection
                mediaPath=""
                mediaType="video"
                isLocked={false}
                onPickMedia={onPickMedia}
            />
        );

        fireEvent.click(screen.getByRole("button"));
        expect(onPickMedia).toHaveBeenCalledTimes(1);
    });

    it("calls pick handler on Enter when unlocked", () => {
        const onPickMedia = vi.fn();

        renderWithMantine(
            <LocalMediaSection
                mediaPath=""
                mediaType="video"
                isLocked={false}
                onPickMedia={onPickMedia}
            />
        );

        fireEvent.keyDown(screen.getByRole("button"), {
            key: "Enter",
        });

        expect(onPickMedia).toHaveBeenCalledTimes(1);
    });

    it("calls pick handler on Space when unlocked", () => {
        const onPickMedia = vi.fn();

        renderWithMantine(
            <LocalMediaSection
                mediaPath=""
                mediaType="video"
                isLocked={false}
                onPickMedia={onPickMedia}
            />
        );

        fireEvent.keyDown(screen.getByRole("button"), {
            key: " ",
        });

        expect(onPickMedia).toHaveBeenCalledTimes(1);
    });

    it("does not call pick handler on click when locked", () => {
        const onPickMedia = vi.fn();

        renderWithMantine(
            <LocalMediaSection
                mediaPath=""
                mediaType="video"
                isLocked
                onPickMedia={onPickMedia}
            />
        );

        fireEvent.click(screen.getByRole("button"));
        expect(onPickMedia).not.toHaveBeenCalled();
    });

    it("does not call pick handler on Enter when locked", () => {
        const onPickMedia = vi.fn();

        renderWithMantine(
            <LocalMediaSection
                mediaPath=""
                mediaType="video"
                isLocked
                onPickMedia={onPickMedia}
            />
        );

        fireEvent.keyDown(screen.getByRole("button"), {
            key: "Enter",
        });

        expect(onPickMedia).not.toHaveBeenCalled();
    });
});