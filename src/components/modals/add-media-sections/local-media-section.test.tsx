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
                importMode="copy"
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
                importMode="copy"
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

    it("says the original leaves its folder when a file is picked in Move mode", () => {
        renderWithMantine(
            <LocalMediaSection
                mediaPath="/tmp/video.mp4"
                mediaType="video"
                importMode="move"
                isLocked={false}
                onPickMedia={vi.fn()}
            />
        );

        expect(screen.getByText(/The original file leaves its folder/)).toBeInTheDocument();
    });

    it("says nothing about moving in Copy mode, or before a file is picked", () => {
        const { unmount } = renderWithMantine(
            <LocalMediaSection
                mediaPath="/tmp/video.mp4"
                mediaType="video"
                importMode="copy"
                isLocked={false}
                onPickMedia={vi.fn()}
            />
        );

        expect(screen.queryByText(/leaves its folder/)).not.toBeInTheDocument();
        unmount();

        renderWithMantine(
            <LocalMediaSection
                mediaPath=""
                mediaType="video"
                importMode="move"
                isLocked={false}
                onPickMedia={vi.fn()}
            />
        );

        expect(screen.queryByText(/leaves its folder/)).not.toBeInTheDocument();
    });

    it("shows audio badge for audio media", () => {
        renderWithMantine(
            <LocalMediaSection
                mediaPath="/tmp/audio.mp3"
                mediaType="audio"
                importMode="copy"
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
                importMode="copy"
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
                importMode="copy"
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
                importMode="copy"
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
                importMode="copy"
                isLocked
                onPickMedia={onPickMedia}
            />
        );

        fireEvent.click(screen.getByRole("button"));
        expect(onPickMedia).not.toHaveBeenCalled();
        // Locked is announced, not only enforced, so a screen reader does not offer a control
        // that does nothing.
        expect(screen.getByRole("button")).toHaveAttribute("aria-disabled", "true");
    });

    it("does not mark the picker disabled while it can be used", () => {
        renderWithMantine(
            <LocalMediaSection
                mediaPath=""
                mediaType="video"
                importMode="copy"
                isLocked={false}
                onPickMedia={vi.fn()}
            />
        );

        expect(screen.getByRole("button")).not.toHaveAttribute("aria-disabled");
    });

    it("does not call pick handler on Enter when locked", () => {
        const onPickMedia = vi.fn();

        renderWithMantine(
            <LocalMediaSection
                mediaPath=""
                mediaType="video"
                importMode="copy"
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