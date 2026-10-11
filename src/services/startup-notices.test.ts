import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupNotices } from "../types/generated/StartupNotices";

const NO_NOTICES: StartupNotices = {
    databaseIntegrityFailed: false,
    pendingMediaAbandoned: null,
    importedMissingFiles: null,
    importApplyFailed: false,
    databaseDisplaced: false,
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

    it("sends one take at a time, so a hook looks only after the answer before it was merged", async () => {
        // The three alert hooks pull at once on mount, and the backend hands everything to the first
        // take it answers. Sent together, the answers could come back in any order.
        const pulls = [pullStartupNotices(), pullStartupNotices(), pullStartupNotices()];
        await vi.waitFor(() => expect(pendingTakes).toHaveLength(1));

        pendingTakes[0]?.({ ...NO_NOTICES, importApplyFailed: true, pendingMediaAbandoned: 2 });
        await pulls[0];
        await vi.waitFor(() => expect(pendingTakes).toHaveLength(2));
        pendingTakes[1]?.({ ...NO_NOTICES });
        await vi.waitFor(() => expect(pendingTakes).toHaveLength(3));
        pendingTakes[2]?.({ ...NO_NOTICES });
        await Promise.all(pulls);

        expect(consumeStartupNotice("importApplyFailed")).toBe(true);
        expect(consumeStartupNotice("pendingMediaAbandoned")).toBe(2);
    });

    it("keeps a notice one hook has not consumed yet while another hook consumes its own", async () => {
        const first = pullStartupNotices();
        const second = pullStartupNotices();

        await vi.waitFor(() => expect(pendingTakes).toHaveLength(1));
        pendingTakes[0]?.({ ...NO_NOTICES, databaseIntegrityFailed: true, importedMissingFiles: 3 });
        await first;
        expect(consumeStartupNotice("databaseIntegrityFailed")).toBe(true);

        await vi.waitFor(() => expect(pendingTakes).toHaveLength(2));
        pendingTakes[1]?.({ ...NO_NOTICES });
        await second;

        expect(consumeStartupNotice("importedMissingFiles")).toBe(3);
    });

    it("hands each notice out once", async () => {
        const pull = pullStartupNotices();
        await vi.waitFor(() => expect(pendingTakes).toHaveLength(1));
        pendingTakes[0]?.({ ...NO_NOTICES, importApplyFailed: true });
        await pull;

        expect(consumeStartupNotice("importApplyFailed")).toBe(true);
        expect(consumeStartupNotice("importApplyFailed")).toBe(false);
    });
});
