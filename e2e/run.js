// Drives the built app through `tauri-driver` and fails when a flow does not reach what the user
// should see. Run by `.github/workflows/e2e.yml`, which builds the binary, starts the driver and
// points the app at empty data directories, so every run is a first launch.
//
//   node e2e/run.js <path to the built binary> [driver url]
//
// The flows find things by the text and the accessible names the user reads (`ui-text.ts`), not by
// test ids, which the components do not carry.

import { createSession, waitFor } from "./webdriver.js";

const [application, driver = "http://127.0.0.1:4444"] = process.argv.slice(2);

if (!application) {
    console.error("usage: node e2e/run.js <path to the built binary> [driver url]");
    process.exit(2);
}

async function waitForText(session, text) {
    return waitFor(`"${text}"`, async () => (await session.findByText(text))[0]);
}

async function clickButton(session, label) {
    const button = await waitFor(`the "${label}" button`, async () => (await session.findButton(label))[0]);
    await session.click(button);
}

// The update check runs at startup and can open a notice if the runner sees a newer release. It is
// not what these flows are about, so it is closed if it shows up.
async function closeNoticeIfShown(session) {
    const [close] = await session.findButton("Close");

    if (close) {
        await session.click(close);
    }
}

// What the window held when a flow failed, so a timeout says whether the page was blank, still
// loading, an error screen or simply different from what the flow expected.
async function describePage(session) {
    try {
        const state = await session.execute(
            "return { url: location.href, title: document.title, ready: document.readyState, " +
                "text: (document.body ? document.body.innerText : '').slice(0, 400) };"
        );

        return JSON.stringify(state);
    } catch (error) {
        return `could not be read (${error.message})`;
    }
}

const flows = [
    [
        "a first launch opens on the empty library",
        async (session) => {
            await waitForText(session, "No channels yet");
            await waitForText(session, "Library folder not configured");
            await waitFor("a button to choose the library folder", async () =>
                (await session.findButton("Choose library folder")).length > 0
            );
        },
    ],
    [
        "Settings opens and shows the database section",
        async (session) => {
            await closeNoticeIfShown(session);
            await clickButton(session, "Open settings");
            await waitForText(session, "Database");
            await clickButton(session, "Close settings");
        },
    ],
    [
        "the full integrity check passes on a new database",
        async (session) => {
            await closeNoticeIfShown(session);
            await clickButton(session, "Open settings");
            await clickButton(session, "Diagnostics");
            await clickButton(session, "Run full integrity check");
            await waitForText(session, "No problems found");
        },
    ],
];

let failed = 0;

// One session for all the flows, in order. A first launch is what the first flow checks, and the
// app starts once per session.
const session = await createSession(driver, application);

try {
    for (const [name, flow] of flows) {
        try {
            await flow(session);
            console.log(`ok   ${name}`);
        } catch (error) {
            failed += 1;
            console.error(`FAIL ${name}\n     ${error.message}`);
            console.error(`     page: ${await describePage(session)}`);
        }
    }
} finally {
    await session.end().catch(() => {});
}

if (failed > 0) {
    console.error(`\n${failed} of ${flows.length} flow(s) failed.`);
    process.exit(1);
}

console.log(`\nAll ${flows.length} flows passed.`);
