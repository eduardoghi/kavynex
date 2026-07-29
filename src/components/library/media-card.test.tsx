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
        fileSrcFromAbsolutePath: vi.fn((path: string | null) => {
            return path ? `file://${path}` : "";
        }),
        formatPublishedDate: vi.fn((publishedAt: string | null) => {
            return publishedAt ? "2026-03-31" : "";
        }),
    };
});

describe("MediaCard", () => {
    it("draws the display-sized copy when one has been resolved", () => {
        // The whole payoff of the derivative cache: the card has to actually point at the smaller
        // file, not merely receive it. A webview decodes an image at its natural size, so rendering
        // the stored 1280x720 file into a 280px card costs the full bitmap either way.
        renderWithMantine(
            <MediaCard
                media={createMedia({ title: "Video A", thumbnail_path: "thumbnails/thumb_a.jpg" })}
                libraryPath="/library"
                displayThumbnailPath="/cache/thumb-display/a.jpg"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByAltText("Video A")).toHaveAttribute(
            "src",
            "file:///cache/thumb-display/a.jpg"
        );
    });

    it("falls back to the stored thumbnail when no display copy was resolved", () => {
        // Absent is the ordinary state, not an error one: it is what every card shows on first paint
        // and what it keeps showing when a derivative cannot be produced (no FFmpeg on the machine,
        // a thumbnail the app did not write). The card must render exactly as it did before the
        // cache existed.
        renderWithMantine(
            <MediaCard
                media={createMedia({ title: "Video A", thumbnail_path: "thumbnails/thumb_a.jpg" })}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByAltText("Video A")).toHaveAttribute(
            "src",
            "file:///library/thumbnails/thumb_a.jpg"
        );
    });

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

    it("falls back to the placeholder when the thumbnail file is gone", () => {
        // A row can point at a thumbnail that is no longer on disk (moved or deleted outside the
        // app - the case Diagnostics reports as "some thumbnail files are missing on disk"). The
        // browser's broken-image glyph reads as the app being broken rather than as a missing file.
        renderWithMantine(
            <MediaCard
                media={createMedia({
                    title: "Video A",
                    thumbnail_path: "thumbnails/thumb_abc.png",
                    media_type: "video",
                })}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        const image = screen.getByAltText("Video A");
        expect(image).toBeInTheDocument();

        fireEvent.error(image);

        // The same placeholder a media with no thumbnail at all shows.
        expect(screen.queryByAltText("Video A")).not.toBeInTheDocument();
    });

    it("shows a thumbnail again after a failed one is replaced", () => {
        // The failure is keyed to the thumbnail it happened on, so replacing a missing thumbnail
        // does not leave the card stuck on the placeholder for the rest of the session.
        const { rerender } = renderWithMantine(
            <MediaCard
                media={createMedia({
                    title: "Video A",
                    thumbnail_path: "thumbnails/gone.png",
                })}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        fireEvent.error(screen.getByAltText("Video A"));
        expect(screen.queryByAltText("Video A")).not.toBeInTheDocument();

        rerender(
            <MediaCard
                media={createMedia({
                    title: "Video A",
                    thumbnail_path: "thumbnails/replacement.png",
                })}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByAltText("Video A")).toBeInTheDocument();
    });

    it("drops the active glow once the media is no longer the active one", () => {
        // The card that opened the player kept its violet glow after the player closed, on every
        // card the user had ever opened. The cause was the inactive box-shadow being invalid CSS
        // (light-dark() around whole shadows rather than around their colors): assigning an invalid
        // value to an inline style is ignored, so the previous - active, violet - value stayed put.
        // Both the badge and the border reset correctly, which is why the state looked half-applied.
        const media = createMedia({ title: "Video A" });

        const { rerender } = renderWithMantine(
            <MediaCard
                media={media}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                isActive
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        const card = screen.getByText("Video A").closest("[class*='mantine-Paper-root']");
        expect(card).not.toBeNull();
        expect((card as HTMLElement).style.boxShadow).toContain("124,92,255");

        rerender(
            <MediaCard
                media={media}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                isActive={false}
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        // The glow is gone, and the resting elevation actually applied rather than being dropped as
        // an invalid declaration - the second half of the same defect, which left every card flat.
        expect((card as HTMLElement).style.boxShadow).not.toContain("124,92,255");
        expect((card as HTMLElement).style.boxShadow).not.toBe("");
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

    it("disables the watch/unwatch menu item while that card's toggle is in flight", async () => {
        // Before this, clicking Mark as watched/unwatched from the card menu gave no feedback and
        // a second click while the first was still in flight was silently ignored.
        const media = createMedia({
            title: "Video A",
            watched_at: null,
        });

        renderWithMantine(
            <MediaCard
                media={media}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
                isWatchedActionInFlight
            />
        );

        fireEvent.click(screen.getByLabelText(/actions for video a/i));

        expect(
            await screen.findByRole("menuitem", { name: /mark as watched/i })
        ).toBeDisabled();
    });

    it("keeps the watch/unwatch menu item enabled when no toggle is in flight", async () => {
        const media = createMedia({
            title: "Video A",
            watched_at: null,
        });

        renderWithMantine(
            <MediaCard
                media={media}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
                onMarkWatched={vi.fn()}
                onMarkUnwatched={vi.fn()}
            />
        );

        fireEvent.click(screen.getByLabelText(/actions for video a/i));

        expect(
            await screen.findByRole("menuitem", { name: /mark as watched/i })
        ).not.toBeDisabled();
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