import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupNotices } from "../types/generated/StartupNotices";

const NO_NOTICES: StartupNotices = {
    databaseIntegrityFailed: false,
    pendingMediaAbandoned: null,
    importedMissingFiles: null,
    importApplyFailed: false,
};

// Each take is answered by hand, so a test decides the order the answers arrive in.
const pendingTakes: Array<(notices: StartupNotices) => void> = [];

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(
        () =>
            new Promise<StartupNotices>((resolve) => {
                pendingTakes.push(resolve);
            }),
    ),
}));

import {
    consumeStartupNotice,
    pullStartupNotices,
    resetStartupNoticesForTests,
} from "./startup-notices";

describe("startup notices", () => {
    beforeEach(() => {
        pendingTakes.length = 0;
        resetStartupNoticesForTests();
    });

    it("keeps what the first of several concurrent takes returned", async () => {
        // The three alert hooks pull at once on mount. The backend hands everything to whichever
        // take it answers first and nothing to the others.
        const pulls = [pullStartupNotices(), pullStartupNotices(), pullStartupNotices()];

        pendingTakes[1]?.({ ...NO_NOTICES, importApplyFailed: true, pendingMediaAbandoned: 2 });
        await pulls[1];
        pendingTakes[0]?.({ ...NO_NOTICES });
        pendingTakes[2]?.({ ...NO_NOTICES });
        await Promise.all(pulls);

        expect(consumeStartupNotice("importApplyFailed")).toBe(true);
        expect(consumeStartupNotice("pendingMediaAbandoned")).toBe(2);
    });

    it("keeps a notice one hook has not consumed yet while another hook consumes its own", async () => {
        const first = pullStartupNotices();
        const second = pullStartupNotices();

        pendingTakes[0]?.({ ...NO_NOTICES, databaseIntegrityFailed: true, importedMissingFiles: 3 });
        await first;
        expect(consumeStartupNotice("databaseIntegrityFailed")).toBe(true);

        pendingTakes[1]?.({ ...NO_NOTICES });
        await second;

        expect(consumeStartupNotice("importedMissingFiles")).toBe(3);
    });

    it("hands each notice out once", async () => {
        const pull = pullStartupNotices();
        pendingTakes[0]?.({ ...NO_NOTICES, importApplyFailed: true });
        await pull;

        expect(consumeStartupNotice("importApplyFailed")).toBe(true);
        expect(consumeStartupNotice("importApplyFailed")).toBe(false);
    });
});
