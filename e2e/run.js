// Drives the built app through `tauri-driver` and fails when a flow does not reach what the user
// should see. Run by `.github/workflows/e2e.yml`, which builds the binary, starts the driver and
// points the app at empty data directories, so every run is a first launch.
//
//   node e2e/run.js <path to the built binary> [driver url]
//
// The flows find things by the text and the accessible names the user reads (`ui-text.ts`), not by
// test ids, which the components do not carry.
//
// A native dialog is out of WebDriver's reach, so the workflow names what each one answers through
// the environment the app inherits (`KAVYNEX_E2E_PICK_FOLDER`, `KAVYNEX_E2E_PICK_FILE`,
// `KAVYNEX_E2E_SAVE_FILE`), which a debug build reads instead of opening the dialog
// (`commands/dialog.rs`). The flows past the first three need them, and are skipped when they are
// not set.

import { existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { expectReadableContrast } from "./contrast.js";
import { createSession, waitFor } from "./webdriver.js";

const PICKED_FOLDER = process.env.KAVYNEX_E2E_PICK_FOLDER ?? "";
const PICKED_FILE = process.env.KAVYNEX_E2E_PICK_FILE ?? "";
const SAVED_FILE = process.env.KAVYNEX_E2E_SAVE_FILE ?? "";
// The title the add form fills in from the picked file's name.
const MEDIA_TITLE = basename(PICKED_FILE, extname(PICKED_FILE));

const [application, driver = "http://127.0.0.1:4444"] = process.argv.slice(2);

if (!application) {
    console.error("usage: node e2e/run.js <path to the built binary> [driver url]");
    process.exit(2);
}

async function waitForText(session, text) {
    return waitFor(`"${text}"`, async () => (await session.findByText(text))[0]);
}

// Retried until the timeout, like a lookup, since a modal that is still opening can refuse a click
// on a button it already renders. `last` takes the last match, which is the one in a modal, since
// Mantine renders modals at the end of the page, after a button of the same name behind them.
async function clickButton(session, label, { last = false } = {}) {
    await waitFor(`the "${label}" button to take a click`, async () => {
        const buttons = await session.findButton(label);
        const button = last ? buttons.at(-1) : buttons[0];

        if (!button) {
            return false;
        }

        await session.click(button);
        return true;
    });
}

// The same, for an element found by what it reads or by its accessible name.
async function clickText(session, text) {
    await waitFor(`"${text}" to take a click`, async () => {
        const [element] = await session.findByText(text);

        if (!element) {
            return false;
        }

        await session.click(element);
        return true;
    });
}

async function clickLabelled(session, label) {
    await waitFor(`"${label}" to take a click`, async () => {
        const [element] = await session.findByLabel(label);

        if (!element) {
            return false;
        }

        await session.click(element);
        return true;
    });
}

async function typeInto(session, label, text) {
    const input = await waitFor(
        `the "${label}" field`,
        async () => (await session.findInput(label))[0]
    );
    await session.type(input, text);
}

async function waitUntilGone(session, description, find) {
    await waitFor(`${description} to go`, async () => (await find()).length === 0);
}

// The update check runs at startup and can open a notice if the runner sees a newer release. It is
// not what these flows are about, so it is closed if it shows up.
async function closeNoticeIfShown(session) {
    const [close] = await session.findButton("Close");

    if (close) {
        await session.click(close);
    }
}

// Runs `check` in the dark theme the app opens in and again in the light one, then leaves it dark,
// so the flows after it see the page they expect.
async function inBothThemes(session, check) {
    await check("the dark theme");
    await clickButton(session, "Switch to light theme");
    try {
        await check("the light theme");
    } finally {
        await clickButton(session, "Switch to dark theme");
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
        "the text on the empty library and in Settings is readable in both themes",
        async (session) => {
            await closeNoticeIfShown(session);
            await inBothThemes(session, async (theme) => {
                await expectReadableContrast(session, `the empty library, ${theme}`);
                await clickButton(session, "Open settings");
                await waitForText(session, "Database");
                try {
                    await expectReadableContrast(session, `Settings, ${theme}`);
                } finally {
                    await clickButton(session, "Close settings");
                }
            });
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

// The flows that need a dialog answered, in the order they build on each other. Each starts from
// the page the one before it left.
const dialogFlows = [
    [
        "choosing a library folder sets the library up",
        async (session) => {
            await closeNoticeIfShown(session);
            // Diagnostics may still be open from the flow before.
            const [closeDiagnostics] = await session.findButton("Close diagnostics");

            if (closeDiagnostics) {
                await session.click(closeDiagnostics);
            }

            await clickButton(session, "Choose library folder");
            await waitUntilGone(session, "the missing library notice", () =>
                session.findByText("Library folder not configured")
            );
        },
    ],
    [
        "a new channel is created and opened",
        async (session) => {
            await clickButton(session, "New channel");
            await typeInto(session, "Name", "E2E Channel");
            await typeInto(session, "YouTube handle", "@e2echannel");
            await clickButton(session, "Create", { last: true });
            await waitFor("the channel page", async () =>
                (await session.findButton("Add media")).length > 0
            );
        },
    ],
    [
        "a local video is imported into the channel",
        async (session) => {
            await clickButton(session, "Add media");
            await clickText(session, "Choose a video/audio file to import");
            await waitFor("the title filled in from the file name", async () => {
                const [title] = await session.findInput("Title");
                return title && (await session.value(title)) === MEDIA_TITLE;
            });
            await clickButton(session, "Add media", { last: true });
            // Long enough for the copy, the thumbnail FFmpeg makes and the registration.
            await waitFor(
                `the card of "${MEDIA_TITLE}"`,
                async () => (await session.findByLabel(`Open ${MEDIA_TITLE}`)).length > 0,
                60_000
            );
            // The card lands before the form closes, and the contrast check after this would
            // otherwise read the form's controls while they are still locked and dimmed.
            await waitUntilGone(session, "the import form", () =>
                session.findByText("Import media")
            );
        },
    ],
    [
        "the text on a channel page with a media is readable in both themes",
        async (session) => {
            await inBothThemes(session, (theme) =>
                expectReadableContrast(session, `the channel page, ${theme}`)
            );
        },
    ],
    [
        "the imported video opens in the player and loads",
        async (session) => {
            await clickLabelled(session, `Open ${MEDIA_TITLE}`);
            // The file reaches the player through the app's own media protocol, which is what this
            // checks. A video element with metadata read got its bytes through it.
            await waitFor(
                "the video to load its metadata",
                async () => {
                    const state = await session.execute(
                        "const video = document.querySelector('video'); " +
                            "return video ? { ready: video.readyState, " +
                            "error: video.error && video.error.code } : null;"
                    );

                    if (state?.error) {
                        throw new Error(`the video failed to load (media error ${state.error})`);
                    }

                    return state !== null && state.ready >= 1;
                },
                30_000
            );
            await clickButton(session, "Back to library");
        },
    ],
    [
        "deleting the media moves its files to the trash",
        async (session) => {
            await clickButton(session, `Actions for ${MEDIA_TITLE}`);
            await clickButton(session, "Delete");
            await clickButton(session, "Delete", { last: true });
            await waitUntilGone(session, `the card of "${MEDIA_TITLE}"`, () =>
                session.findByLabel(`Open ${MEDIA_TITLE}`)
            );
            await clickButton(session, "Open settings");
            await waitForText(session, "The trash holds");
            await clickButton(session, "Close settings");
        },
    ],
    [
        "the database is exported to the chosen file",
        async (session) => {
            await clickButton(session, "Open settings");
            await clickButton(session, "Export database");
            await waitForText(session, "Database exported successfully.");
            await waitFor(`the export at ${SAVED_FILE}`, async () => existsSync(SAVED_FILE));
            await clickButton(session, "Close settings");
        },
    ],
];

if (PICKED_FOLDER && PICKED_FILE && SAVED_FILE) {
    flows.push(...dialogFlows);
} else {
    console.log(
        `skip ${dialogFlows.length} flows that need the dialogs answered ` +
            "(KAVYNEX_E2E_PICK_FOLDER, KAVYNEX_E2E_PICK_FILE, KAVYNEX_E2E_SAVE_FILE)"
    );
}

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
