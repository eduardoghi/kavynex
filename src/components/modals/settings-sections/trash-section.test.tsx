import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TrashSection } from "./trash-section";
import { renderWithMantine } from "../../../test/test-utils";

type SectionProps = Parameters<typeof TrashSection>[0];

function baseProps(overrides: Partial<SectionProps> = {}): SectionProps {
    return {
        deleteSkipsTrash: false,
        onChangeDeleteSkipsTrash: vi.fn(),
        trashSummary: { files: 3, bytes: 3000, formattedSize: "2.93 KB" },
        isEmptyingTrash: false,
        trashError: "",
        onEmptyTrash: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe("TrashSection", () => {
    it("says what the trash holds", () => {
        renderWithMantine(<TrashSection {...baseProps()} />);

        expect(screen.getByText("The trash holds 3 files (2.93 KB).")).toBeInTheDocument();
    });

    it("asks before emptying the trash, and empties it only on confirm", () => {
        // Emptying deletes for good, so a single click must not reach the backend.
        const onEmptyTrash = vi.fn().mockResolvedValue(undefined);
        renderWithMantine(<TrashSection {...baseProps({ onEmptyTrash })} />);

        fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
        expect(onEmptyTrash).not.toHaveBeenCalled();
        expect(screen.getByText(/in the trash for good/i)).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
        expect(onEmptyTrash).toHaveBeenCalledTimes(1);
    });

    it("cancelling the confirmation empties nothing", () => {
        const onEmptyTrash = vi.fn().mockResolvedValue(undefined);
        renderWithMantine(<TrashSection {...baseProps({ onEmptyTrash })} />);

        fireEvent.click(screen.getByRole("button", { name: "Empty trash" }));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onEmptyTrash).not.toHaveBeenCalled();
        expect(screen.queryByText(/in the trash for good/i)).not.toBeInTheDocument();
    });

    it("cannot empty a trash that holds nothing", () => {
        renderWithMantine(
            <TrashSection
                {...baseProps({ trashSummary: { files: 0, bytes: 0, formattedSize: "0 B" } })}
            />
        );

        expect(screen.getByText("The trash is empty.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Empty trash" })).toBeDisabled();
    });

    it("turns on deleting right away from the switch", () => {
        const onChangeDeleteSkipsTrash = vi.fn();
        renderWithMantine(<TrashSection {...baseProps({ onChangeDeleteSkipsTrash })} />);

        fireEvent.click(screen.getByRole("switch"));

        expect(onChangeDeleteSkipsTrash).toHaveBeenCalledWith(true);
    });
});
