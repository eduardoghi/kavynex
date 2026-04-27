import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddMediaModalActions } from "./add-media-modal-actions";
import { renderWithMantine } from "../../../test/test-utils";

describe("AddMediaModalActions", () => {
    it("renders add and cancel buttons", () => {
        renderWithMantine(
            <form>
                <AddMediaModalActions
                    isYtDlpRunning={false}
                    isUrlMode={false}
                    isCancellingYtDlp={false}
                    isModalLocked={false}
                    canSubmit
                    isBusy={false}
                    loading={false}
                    onClose={vi.fn()}
                />
            </form>
        );

        expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /add media/i })).toBeInTheDocument();
    });

    it("shows cancel download button when yt-dlp is running in url mode", () => {
        renderWithMantine(
            <form>
                <AddMediaModalActions
                    isYtDlpRunning
                    isUrlMode
                    isCancellingYtDlp={false}
                    isModalLocked
                    canSubmit
                    isBusy={false}
                    loading={false}
                    onCancelYtDlpDownload={vi.fn()}
                    onClose={vi.fn()}
                />
            </form>
        );

        expect(screen.getByRole("button", { name: /cancel download/i })).toBeInTheDocument();
    });

    it("calls close handler", () => {
        const onClose = vi.fn();

        renderWithMantine(
            <form>
                <AddMediaModalActions
                    isYtDlpRunning={false}
                    isUrlMode={false}
                    isCancellingYtDlp={false}
                    isModalLocked={false}
                    canSubmit
                    isBusy={false}
                    loading={false}
                    onClose={onClose}
                />
            </form>
        );

        fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("submits form through add button", () => {
        const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());

        renderWithMantine(
            <form onSubmit={onSubmit}>
                <AddMediaModalActions
                    isYtDlpRunning={false}
                    isUrlMode={false}
                    isCancellingYtDlp={false}
                    isModalLocked={false}
                    canSubmit
                    isBusy={false}
                    loading={false}
                    onClose={vi.fn()}
                />
            </form>
        );

        fireEvent.click(screen.getByRole("button", { name: /add media/i }));
        expect(onSubmit).toHaveBeenCalledTimes(1);
    });
});