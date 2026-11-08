import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithMantine } from "../../test/test-utils";
import type { WorkInProgress } from "../../types/generated/WorkInProgress";

const guard = {
    pending: null as WorkInProgress | null,
    keepRunning: vi.fn(),
    closeAnyway: vi.fn().mockResolvedValue(undefined),
};

vi.mock("../../hooks/use-close-guard", () => ({
    useCloseGuard: () => guard,
}));

import { CloseWhileBusyPrompt, describeWork } from "./close-while-busy-prompt";

const IDLE: WorkInProgress = {
    downloading: false,
    addingMedia: false,
    verifyingLibrary: false,
    movingLibrary: false,
};

describe("describeWork", () => {
    it("names one kind of work, or lists several in order", () => {
        expect(describeWork({ ...IDLE, downloading: true })).toBe("a download");
        expect(describeWork({ ...IDLE, downloading: true, movingLibrary: true })).toBe(
            "a download and the library move"
        );
        expect(
            describeWork({ ...IDLE, downloading: true, addingMedia: true, verifyingLibrary: true })
        ).toBe("a download, a media being added and the library verification");
    });
});

describe("CloseWhileBusyPrompt", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        guard.pending = null;
    });

    it("stays closed while no close is held", () => {
        renderWithMantine(<CloseWhileBusyPrompt />);

        expect(screen.queryByText("Close Kavynex?")).toBeNull();
    });

    it("says what a close would stop and answers through the guard", () => {
        guard.pending = { ...IDLE, downloading: true };
        renderWithMantine(<CloseWhileBusyPrompt />);

        expect(screen.getByText("Closing now stops a download.")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
        expect(guard.keepRunning).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));
        expect(guard.closeAnyway).toHaveBeenCalledTimes(1);
    });
});
