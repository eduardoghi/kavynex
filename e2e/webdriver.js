// The few W3C WebDriver calls the end-to-end flows need, over `fetch`, against `tauri-driver`.
//
// A client library (WebdriverIO, selenium-webdriver) would bring a large dependency tree into a
// project that keeps its dev tree small, for a handful of HTTP requests. What is here is the subset
// the flows use. A flow that needs more adds the call here.

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export class WebDriverError extends Error {}

// The id inside an element reference. W3C names the key `ELEMENT_KEY`, and older drivers used
// `ELEMENT`. A reference with neither is reported with its shape, rather than read as an element
// that is not there.
function elementId(reference) {
    const id = reference?.[ELEMENT_KEY] ?? reference?.ELEMENT;

    if (typeof id !== "string") {
        throw new WebDriverError(`unexpected element reference: ${JSON.stringify(reference)}`);
    }

    return id;
}

async function request(base, method, path, body) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        const detail =
            [payload?.value?.error, payload?.value?.message].filter(Boolean).join(": ") ||
            response.statusText;
        throw new WebDriverError(`${method} ${path} failed (${response.status}): ${detail}`);
    }

    return payload.value;
}

export async function createSession(base, application) {
    const value = await request(base, "POST", "/session", {
        capabilities: {
            alwaysMatch: {
                browserName: "wry",
                "tauri:options": { application },
            },
        },
    });

    return new Session(base, value.sessionId);
}

class Session {
    constructor(base, id) {
        this.base = base;
        this.id = id;
    }

    call(method, path, body) {
        return request(this.base, method, `/session/${this.id}${path}`, body);
    }

    // Every element whose text contains `text`, as WebDriver element ids. XPath, because the flows
    // find things by what the user reads rather than by a selector a refactor can rename.
    async findByText(text) {
        const literal = JSON.stringify(text);
        const found = await this.call("POST", "/elements", {
            using: "xpath",
            value: `//*[contains(normalize-space(.), ${literal}) and not(*[contains(normalize-space(.), ${literal})])]`,
        });

        return found.map(elementId);
    }

    async findButton(label) {
        const literal = JSON.stringify(label);
        const found = await this.call("POST", "/elements", {
            using: "xpath",
            value: `//button[normalize-space(.)=${literal} or @aria-label=${literal}]`,
        });

        return found.map(elementId);
    }

    // Scrolls the element to the middle of its scroll container first. A button below the fold of a
    // modal's scroll area is refused as not interactable otherwise.
    async click(element) {
        await this.call("POST", "/execute/sync", {
            script: "arguments[0].scrollIntoView({ block: 'center' });",
            args: [{ [ELEMENT_KEY]: element }],
        });

        return this.call("POST", `/element/${element}/click`, {});
    }

    title() {
        return this.call("GET", "/title");
    }

    // Runs `script` in the page and returns what it returns.
    execute(script) {
        return this.call("POST", "/execute/sync", { script, args: [] });
    }

    end() {
        return this.call("DELETE", "");
    }
}

// Polls `probe` until it returns something truthy, or fails with `description` after `timeoutMs`.
export async function waitFor(description, probe, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
        try {
            const value = await probe();

            if (value) {
                return value;
            }
        } catch (error) {
            lastError = error;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const cause = lastError ? ` (last error: ${lastError.message})` : "";
    throw new WebDriverError(`timed out waiting for ${description}${cause}`);
}
