import { describe, expect, it } from "vitest";
import type { AxeResults } from "axe-core";
import { describeViolations } from "./axe";

type Violation = AxeResults["violations"][number];

// Only the four fields describeViolations reads. A real axe violation carries a good deal more
// (impact, tags, the full outer HTML of every matching node), which is exactly why the formatter
// exists - printing them raw buries the rule id that says what is wrong.
function violation(id: string, help: string, targets: string[][]): Violation {
    return {
        id,
        help,
        nodes: targets.map((target) => ({ target })),
    } as unknown as Violation;
}

describe("describeViolations", () => {
    it("is empty for a clean run", () => {
        // The five component checks assert against this exact value, so an empty result has to
        // format to an empty string rather than to something falsy-but-not-equal.
        expect(describeViolations([])).toBe("");
    });

    it("names the rule, its help text and every node it matched", () => {
        // The failure message is the whole point of the helper: a report that says "1 violation"
        // sends whoever hit it to the axe docs, while this one says which rule and which element.
        const formatted = describeViolations([
            violation("button-name", "Buttons must have discernible text", [
                ["#save"],
                ["#cancel"],
            ]),
        ]);

        expect(formatted).toBe(
            "button-name: Buttons must have discernible text (#save, #cancel)"
        );
    });

    it("puts one violation per line", () => {
        // A refactor that dropped a role can trip several rules at once, and running them together
        // on one line is how a report becomes unreadable at exactly the moment it is needed.
        const formatted = describeViolations([
            violation("list", "Lists must only contain li elements", [["ul"]]),
            violation("aria-required-parent", "Items must be contained by their role", [["li"]]),
        ]);

        expect(formatted.split("\n")).toEqual([
            "list: Lists must only contain li elements (ul)",
            "aria-required-parent: Items must be contained by their role (li)",
        ]);
    });

    it("joins a nested target selector rather than printing an array", () => {
        // axe reports a target inside a shadow root or an iframe as an array of selectors, one per
        // boundary crossed. Left as an array it would stringify with commas and read as two
        // separate elements.
        const formatted = describeViolations([
            violation("color-contrast", "Elements must meet contrast", [
                ["#host", "#inner"],
            ]),
        ]);

        expect(formatted).toBe("color-contrast: Elements must meet contrast (#host #inner)");
    });
});
