// A thin wrapper over axe-core for the accessibility smoke tests.
//
// axe-core is used directly rather than through `vitest-axe`, whose only published releases are
// `1.0.0-pre.*`. This project pins `vitest` to an exact version and has already paid for a
// bleeding-edge dependency once (the vite/rolldown transform flakiness), so a prerelease wrapper is
// not worth taking on for what amounts to fifteen lines. axe-core itself is Deque's own, stable, and
// dev-scope only. It is never bundled into the app.
//
// What these checks are for, and what they are not: they pin the *structure* the virtualized lists
// depend on. `MediaGrid` and `ChannelSidebar` render only the rows near the viewport, so assistive
// technology cannot count the items by walking the DOM. The explicit `list` role plus
// `aria-setsize`/`aria-posinset` on each row are what restore that, and nothing failed if a refactor
// dropped them. They are also blind to the things jsdom has no answer for: colour contrast needs
// real computed styles, and focus order needs a real layout. Neither is asserted here, and neither
// should be read as covered.
import axe, { type AxeResults, type RunOptions } from "axe-core";

// Rules that cannot produce a meaningful verdict in jsdom, so leaving them on would report
// violations that say nothing about the component under test.
//
// - `color-contrast` needs computed colours from a real rendering engine; jsdom returns none, and
//   axe either skips it or guesses.
// - `region` wants every node inside a landmark, which is a property of the whole page. These
//   components are rendered in isolation, so the landmark that holds them in the app is absent by
//   construction rather than missing.
const DISABLED_IN_JSDOM: RunOptions = {
    rules: {
        "color-contrast": { enabled: false },
        region: { enabled: false },
    },
};

/**
 * Runs axe over `container` and returns its violations.
 *
 * The caller asserts on the result rather than this throwing, so a failure names the rule and the
 * node in the test's own message instead of in a stack trace.
 */
export async function findAccessibilityViolations(
    container: Element
): Promise<AxeResults["violations"]> {
    const results = await axe.run(container, DISABLED_IN_JSDOM);

    return results.violations;
}

/**
 * A compact, readable summary of what axe found, for a failing assertion's message.
 *
 * axe's own violation objects are large (each carries every matching node with its full HTML), so
 * printing them raw buries the rule id that actually says what is wrong.
 */
export function describeViolations(violations: AxeResults["violations"]): string {
    return violations
        .map((violation) => {
            const targets = violation.nodes
                .map((node) => node.target.join(" "))
                .join(", ");

            return `${violation.id}: ${violation.help} (${targets})`;
        })
        .join("\n");
}
