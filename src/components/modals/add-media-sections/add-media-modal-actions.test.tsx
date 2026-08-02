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
                    isImportingLocalFile={false}
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
                    isImportingLocalFile={false}
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

    it("shows a cancel import button while a local file is being imported", () => {
        const onCancel = vi.fn();

        renderWithMantine(
            <form>
                <AddMediaModalActions
                    isYtDlpRunning={false}
                    isUrlMode={false}
                    isImportingLocalFile
                    isCancellingYtDlp={false}
                    isModalLocked
                    canSubmit
                    isBusy={false}
                    loading
                    onCancelYtDlpDownload={onCancel}
                    onClose={vi.fn()}
                />
            </form>
        );

        // Worded for the operation in front of the user: "Cancel download" over a file copy would
        // describe the wrong thing. The handler is shared because the backend mechanism is - an
        // import registers the same kind of run a download does.
        const button = screen.getByRole("button", { name: /cancel import/i });
        fireEvent.click(button);

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole("button", { name: /cancel download/i })).not.toBeInTheDocument();
    });

    it("offers no cancel button in local mode when no import is running", () => {
        // The guard that keeps the button from appearing over an idle form: it is the import being
        // in flight that makes it meaningful, not the mode.
        renderWithMantine(
            <form>
                <AddMediaModalActions
                    isYtDlpRunning={false}
                    isUrlMode={false}
                    isImportingLocalFile={false}
                    isCancellingYtDlp={false}
                    isModalLocked={false}
                    canSubmit
                    isBusy={false}
                    loading={false}
                    onCancelYtDlpDownload={vi.fn()}
                    onClose={vi.fn()}
                />
            </form>
        );

        expect(screen.queryByRole("button", { name: /cancel import/i })).not.toBeInTheDocument();
    });

    it("calls close handler", () => {
        const onClose = vi.fn();

        renderWithMantine(
            <form>
                <AddMediaModalActions
                    isYtDlpRunning={false}
                    isUrlMode={false}
                    isImportingLocalFile={false}
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
                    isImportingLocalFile={false}
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