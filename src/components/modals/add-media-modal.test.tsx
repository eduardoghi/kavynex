import { useState } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddMediaModal } from "./add-media-modal";
import { renderWithMantine } from "../../test/test-utils";
import { describeViolations, findAccessibilityViolations } from "../../test/axe";
import { getExternalToolsStatus } from "../../services/diagnostics-external-tools";

vi.mock("../../services/diagnostics-external-tools", () => ({
    getExternalToolsStatus: vi.fn(() => new Promise(() => {})),
}));

function createDefaultProps(): React.ComponentProps<typeof AddMediaModal> {
    return {
        opened: true,
        onClose: vi.fn(),
        sourceMode: "local",
        mediaUrl: "",
        title: "",
        mediaPath: "",
        mediaType: "video",
        thumbPath: "",
        publishedAt: "",
        downloadComments: true,
        downloadLiveChat: true,
        cookiesBrowser: "",
        cookiesPath: "",
        isGeneratingThumb: false,
        loading: false,
        isCancellingYtDlp: false,
        ytDlpLogs: [],
        isYtDlpRunning: false,
        ytDlpFormats: [],
        selectedYtDlpFormatId: "",
        isLoadingYtDlpFormats: false,
        onChangeSourceMode: vi.fn(),
        onChangeMediaUrl: vi.fn(),
        onChangeTitle: vi.fn(),
        onChangePublishedAt: vi.fn(),
        onChangeDownloadComments: vi.fn(),
        onChangeDownloadLiveChat: vi.fn(),
        onChangeCookiesBrowser: vi.fn(),
        onPickCookiesFile: vi.fn(),
        onClearCookiesPath: vi.fn(),
        onChangeSelectedYtDlpFormatId: vi.fn(),
        onLoadYtDlpFormats: vi.fn(),
        onPickMedia: vi.fn(),
        onPickThumb: vi.fn(),
        onAdd: vi.fn(),
        onCancelYtDlpDownload: vi.fn(),
    };
}

function renderAddMediaModal(
    overrides: Partial<React.ComponentProps<typeof AddMediaModal>> = {}
): ReturnType<typeof renderWithMantine> {
    return renderWithMantine(<AddMediaModal {...createDefaultProps()} {...overrides} />);
}

describe("AddMediaModal", () => {
    it("renders local mode by default", () => {
        renderAddMediaModal();

        expect(screen.getByText("Import media")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /add media/i })).toBeDisabled();
    });

    it("enables add button when local media path exists", () => {
        renderAddMediaModal({
            title: "Test",
            mediaPath: "/tmp/file.mp4",
        });

        expect(screen.getByRole("button", { name: /add media/i })).toBeEnabled();
    });

    it("calls add handler", () => {
        const onAdd = vi.fn();

        renderAddMediaModal({
            title: "Test",
            mediaPath: "/tmp/file.mp4",
            onAdd,
        });

        fireEvent.click(screen.getByRole("button", { name: /add media/i }));

        expect(onAdd).toHaveBeenCalledTimes(1);
    });

    it("submits by form submit when valid", () => {
        const onAdd = vi.fn();

        renderAddMediaModal({
            title: "Test",
            mediaPath: "/tmp/file.mp4",
            onAdd,
        });

        const addButton = screen.getByRole("button", { name: /add media/i });
        const form = addButton.closest("form");

        expect(form).not.toBeNull();

        fireEvent.submit(form!);

        expect(onAdd).toHaveBeenCalledTimes(1);
    });

    it("renders yt-dlp mode and disables add when format is missing", () => {
        renderAddMediaModal({
            sourceMode: "yt-dlp",
            mediaUrl: "https://youtube.com/watch?v=abc",
            selectedYtDlpFormatId: "",
        });

        expect(screen.getByLabelText("Media URL")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /add media/i })).toBeDisabled();
    });

    it("enables add button in yt-dlp mode when url and format exist", () => {
        renderAddMediaModal({
            sourceMode: "yt-dlp",
            mediaUrl: "https://youtube.com/watch?v=abc",
            selectedYtDlpFormatId: "best",
        });

        expect(screen.getByRole("button", { name: /add media/i })).toBeEnabled();
    });

    it("calls title change handler", () => {
        const onChangeTitle = vi.fn();

        renderAddMediaModal({
            onChangeTitle,
        });

        fireEvent.change(screen.getByLabelText("Title"), {
            target: {
                value: "New title",
            },
        });

        expect(onChangeTitle).toHaveBeenCalledWith("New title");
    });

    it("calls published date change handler with iso value", () => {
        const onChangePublishedAt = vi.fn();

        renderAddMediaModal({
            onChangePublishedAt,
        });

        fireEvent.change(screen.getByLabelText("Published date"), {
            target: {
                value: "31032026",
            },
        });

        expect(onChangePublishedAt).toHaveBeenCalledWith("2026-03-31");
    });

    it("keeps a partially edited publication date instead of wiping it mid-edit", () => {
        // Model the real controlled flow: the parent stores the published date and feeds it
        // back, so an incomplete date (which normalizes to "") round-trips into the modal.
        const base = createDefaultProps();

        function Controlled(): JSX.Element {
            const [publishedAt, setPublishedAt] = useState("");

            return (
                <AddMediaModal
                    {...base}
                    sourceMode="local"
                    publishedAt={publishedAt}
                    onChangePublishedAt={setPublishedAt}
                />
            );
        }

        renderWithMantine(<Controlled />);

        const input = screen.getByLabelText("Published date");

        // A complete, valid date.
        fireEvent.change(input, { target: { value: "31/03/2026" } });
        expect(input).toHaveValue("31/03/2026");

        // Deleting a digit makes the ISO value round-trip to "" (incomplete), but the partial
        // text being edited must survive rather than be wiped by the resync effect.
        fireEvent.change(input, { target: { value: "31/03/202" } });
        expect(input).toHaveValue("31/03/202");
    });

    it("does not call add while busy", () => {
        const onAdd = vi.fn();

        renderAddMediaModal({
            mediaPath: "/tmp/file.mp4",
            loading: true,
            onAdd,
        });

        const button = screen.getByRole("button", { name: /add media/i });

        expect(button).toBeDisabled();

        const form = button.closest("form");

        expect(form).not.toBeNull();

        fireEvent.submit(form!);

        expect(onAdd).not.toHaveBeenCalled();
    });

    it("warns about a missing tool before anything is filled in", async () => {
        // Composed with the real hook rather than a stubbed warning: what this pins is the wiring,
        // which is the half that can silently come undone while both pieces keep passing their own
        // tests.
        vi.mocked(getExternalToolsStatus).mockResolvedValueOnce({
            yt_dlp: {
                path: "",
                version: "",
                healthy: false,
                release_age_days: null,
            },
            ffmpeg: {
                path: "ffmpeg",
                version: "7.1",
                healthy: true,
                release_age_days: null,
            },
        });

        renderAddMediaModal({ sourceMode: "yt-dlp" });

        expect(await screen.findByText("yt-dlp was not found")).toBeInTheDocument();
    });

    it("has no detectable accessibility violations in each source mode", async () => {
        // Both modes, because they render different form sections and the labelling is per-section:
        // the local mode has the file picker and the import-mode radio group, the yt-dlp mode has
        // the URL field, the format picker and the terminal. A missing label on either is a form
        // control a screen reader cannot name, which is the whole failure this catches.
        for (const sourceMode of ["local", "yt-dlp"] as const) {
            const { container, unmount } = renderAddMediaModal({ sourceMode });

            const violations = await findAccessibilityViolations(container);

            expect(describeViolations(violations), `source mode: ${sourceMode}`).toBe("");

            unmount();
        }
    });
});