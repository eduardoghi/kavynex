import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
}));

vi.mock("../utils/media-utils", () => ({
    setMediaServerOrigin: vi.fn(),
}));

import { TAURI_COMMANDS } from "../constants/tauri-commands";
import { invokeCommand } from "../lib/tauri-client";
import { setMediaServerOrigin } from "../utils/media-utils";

const invokeCommandMock = vi.mocked(invokeCommand);
const setOriginMock = vi.mocked(setMediaServerOrigin);

// The module keeps the one request it made, so each test loads a fresh copy.
async function freshService(): Promise<typeof import("./media-server-service")> {
    vi.resetModules();
    return import("./media-server-service");
}

describe("loadMediaServerOrigin", () => {
    beforeEach(() => {
        invokeCommandMock.mockReset();
        setOriginMock.mockReset();
    });

    it("hands the backend's origin to the media URLs, asking only once", async () => {
        const origin = `http://127.0.0.1:4242/${"a".repeat(64)}`;
        invokeCommandMock.mockResolvedValue(origin as never);
        const { loadMediaServerOrigin } = await freshService();

        await Promise.all([loadMediaServerOrigin(), loadMediaServerOrigin()]);
        await loadMediaServerOrigin();

        expect(invokeCommandMock).toHaveBeenCalledTimes(1);
        expect(invokeCommandMock).toHaveBeenCalledWith(TAURI_COMMANDS.MEDIA_SERVER_ORIGIN);
        expect(setOriginMock).toHaveBeenCalledWith(origin);
    });

    it("keeps the custom scheme when there is no server or the backend could not answer", async () => {
        invokeCommandMock.mockResolvedValue(null as never);
        await (await freshService()).loadMediaServerOrigin();
        expect(setOriginMock).toHaveBeenLastCalledWith(null);

        invokeCommandMock.mockRejectedValue(new Error("unavailable"));
        await expect((await freshService()).loadMediaServerOrigin()).resolves.toBeUndefined();
        expect(setOriginMock).toHaveBeenLastCalledWith(null);
    });
});
