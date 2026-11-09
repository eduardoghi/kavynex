// Checks text contrast in the running app with axe-core's `color-contrast` rule.
//
// The component tests run axe too (src/test/axe.ts), but jsdom computes no colours, so that rule is
// off there and contrast is covered by nothing else. Here the page is drawn by the real webview, in
// whichever theme it is in when the check runs, so a flow calls it once per theme.
//
// axe is read from the installed package and run inside the page through WebDriver, which is not
// held to the page's CSP. Its result is left on `window` and polled, rather than returned from the
// script as a promise, so nothing depends on how the driver handles an asynchronous script.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { waitFor } from "./webdriver.js";

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const RESULT_KEY = "__kavynexContrast";

// Runs the rule over the whole page and returns one line per element that fails it. The page is
// left as it was, and axe stays loaded for the next call.
export async function findContrastViolations(session) {
    // A modal that just opened, or a theme that just switched, is still fading in, and axe would
    // measure its text at whatever opacity the transition had reached. Wait for every animation and
    // transition on the page to finish first. A spinner loops forever and changes no text colour, so
    // an endless animation is not waited for.
    await waitFor("the page's transitions to finish", () =>
        session.execute(
            "return document.getAnimations().every((animation) => " +
                "animation.playState !== 'running' || " +
                "animation.effect?.getComputedTiming().iterations === Infinity);"
        )
    );

    await session.execute(
        `if (!window.axe) { ${AXE_SOURCE}\n}\n` +
            `window.${RESULT_KEY} = null;\n` +
            // Tooltips are left out. One opens under the pointer after a click (the theme
            // switch, typically) and is measured mid-fade, white text over the page behind it.
            "window.axe.run({ exclude: [['[role=\"tooltip\"]']] }, { runOnly: ['color-contrast'] }).then(" +
            `(results) => { window.${RESULT_KEY} = results.violations.flatMap((violation) => ` +
            "violation.nodes.map((node) => `${node.target.join(' ')}: ${node.failureSummary}`)); }," +
            `(error) => { window.${RESULT_KEY} = { error: String(error) }; });\n` +
            "return true;"
    );

    const result = await waitFor(
        "the contrast check to finish",
        () => session.execute(`return window.${RESULT_KEY};`),
        60_000
    );

    if (result.error) {
        throw new Error(`the contrast check could not run (${result.error})`);
    }

    return result;
}

// Fails with every element below the contrast threshold, named by where it was found.
export async function expectReadableContrast(session, where) {
    const violations = await findContrastViolations(session);

    if (violations.length > 0) {
        throw new Error(
            `${violations.length} element(s) with too little contrast in ${where}:\n     ` +
                violations.join("\n     ")
        );
    }
}
