import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithMantine } from "../../test/test-utils";
import { CommentOriginalText } from "./comment-original-text";

describe("CommentOriginalText", () => {
    it("keeps the first version folded until asked for", () => {
        renderWithMantine(<CommentOriginalText originalText="what it said before the edit" />);

        const toggle = screen.getByRole("button", { name: "Show the first version" });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("what it said before the edit")).not.toBeInTheDocument();

        fireEvent.click(toggle);

        expect(screen.getByText("what it said before the edit")).toBeInTheDocument();
        expect(screen.getByText("As first saved")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Hide the first version" })).toHaveAttribute(
            "aria-expanded",
            "true"
        );
    });
});
