import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MediaCard } from "./media-card";
import { createMedia } from "../../test/factories/media";
import { renderWithMantine } from "../../test/test-utils";

vi.mock("../../utils/media-utils", async () => {
    const actual = await vi.importActual<typeof import("../../utils/media-utils")>(
        "../../utils/media-utils"
    );

    return {
        ...actual,
        fileSrcFromStoredPath: vi.fn((thumbnailPath: string | null, libraryPath: string) => {
            if (!thumbnailPath) {
                return "";
            }

            return `file://${libraryPath}/${thumbnailPath}`;
        }),
        formatPublishedDate: vi.fn((publishedAt: string | null) => {
            return publishedAt ? "2026-03-31" : "";
        }),
    };
});

describe("MediaCard", () => {
    it("renders media title and published label", () => {
        renderWithMantine(
            <MediaCard
                media={createMedia({
                    title: "Video A",
                    published_at: "2026-03-31",
                })}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("Video A")).toBeInTheDocument();
        expect(screen.getByText("2026-03-31")).toBeInTheDocument();
    });

    it("opens media on card click", () => {
        const media = createMedia({
            title: "Video A",
        });

        const onOpen = vi.fn();

        renderWithMantine(
            <MediaCard
                media={media}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={onOpen}
                onRequestDelete={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Open Video A" }));
        expect(onOpen).toHaveBeenCalledWith(media);
    });

    it("opens media on Enter key", () => {
        const media = createMedia({
            title: "Video A",
        });

        const onOpen = vi.fn();

        renderWithMantine(
            <MediaCard
                media={media}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={onOpen}
                onRequestDelete={vi.fn()}
            />
        );

        fireEvent.keyDown(screen.getByRole("button", { name: "Open Video A" }), {
            key: "Enter",
        });

        expect(onOpen).toHaveBeenCalledWith(media);
    });

    it("shows watched badge when media was watched", () => {
        renderWithMantine(
            <MediaCard
                media={createMedia({
                    title: "Video A",
                    watched_at: "2026-03-31T10:00:00.000Z",
                })}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("Watched")).toBeInTheDocument();
    });

    it("shows audio badge near metadata for audio media", () => {
        renderWithMantine(
            <MediaCard
                media={createMedia({
                    title: "Audio A",
                    media_type: "audio",
                })}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("Audio")).toBeInTheDocument();
    });

    it("shows video badge near metadata for video media", () => {
        renderWithMantine(
            <MediaCard
                media={createMedia({
                    title: "Video A",
                    media_type: "video",
                })}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("Video")).toBeInTheDocument();
    });

    it("requests delete from menu", async () => {
        const media = createMedia({
            title: "Video A",
        });

        const onRequestDelete = vi.fn();

        renderWithMantine(
            <MediaCard
                media={media}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={onRequestDelete}
            />
        );

        fireEvent.click(screen.getByLabelText(/actions for video a/i));
        fireEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));

        expect(onRequestDelete).toHaveBeenCalledWith(media);
    });
});