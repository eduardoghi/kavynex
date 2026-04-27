import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MediaGrid } from "./media-grid";
import { createMedia } from "../../test/factories/media";
import { renderWithMantine } from "../../test/test-utils";

vi.mock("@tanstack/react-virtual", () => ({
    useVirtualizer: vi.fn(({ count }: { count: number }) => ({
        getTotalSize: () => count * 308,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 308,
            })),
        measureElement: vi.fn(),
        measure: vi.fn(),
    })),
}));

vi.mock("./media-card", () => ({
    MediaCard: ({
        media,
        onOpen,
        onRequestDelete,
    }: {
        media: { title: string };
        onOpen: (media: unknown) => void;
        onRequestDelete: (media: unknown) => void;
    }) => (
        <div>
            <span>{media.title}</span>
            <button onClick={() => onOpen(media)}>open</button>
            <button onClick={() => onRequestDelete(media)}>delete</button>
        </div>
    ),
}));

describe("MediaGrid", () => {
    it("shows loading state", () => {
        renderWithMantine(
            <MediaGrid
                items={[]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("Loading media...")).toBeInTheDocument();
    });

    it("shows empty state", () => {
        renderWithMantine(
            <MediaGrid
                items={[]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("No media yet")).toBeInTheDocument();
    });

    it("renders media items", () => {
        renderWithMantine(
            <MediaGrid
                items={[
                    createMedia({ id: 1, title: "Video A" }),
                    createMedia({ id: 2, title: "Audio B", media_type: "audio" }),
                ]}
                libraryPath="/library"
                shellBorder="rgba(255,255,255,0.1)"
                shellSurface="rgba(255,255,255,0.03)"
                loading={false}
                onOpen={vi.fn()}
                onRequestDelete={vi.fn()}
            />
        );

        expect(screen.getByText("Video A")).toBeInTheDocument();
        expect(screen.getByText("Audio B")).toBeInTheDocument();
    });
});