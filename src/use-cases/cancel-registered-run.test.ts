import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANCEL_RETRY_DELAY_MS, cancelRegisteredRun } from "./cancel-registered-run";

vi.mock("../services/media-download-service", () => ({
    cancelMediaDownload: vi.fn(),
}));

import { cancelMediaDownload } from "../services/media-download-service";

const UNKNOWN_RUN = { code: "INVALID_RUN_ID", message: "unknown run" };

describe("cancelRegisteredRun", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("cancels a run the backend knows with one call", async () => {
        vi.mocked(cancelMediaDownload).mockResolvedValue(undefined);

        await cancelRegisteredRun("run-1");

        expect(vi.mocked(cancelMediaDownload).mock.calls).toEqual([["run-1"]]);
    });

    it("asks once more, after a moment, for a run the backend does not know yet", async () => {
        vi.mocked(cancelMediaDownload)
            .mockRejectedValueOnce(UNKNOWN_RUN)
            .mockResolvedValue(undefined);

        const cancelled = cancelRegisteredRun("run-1");
        await vi.advanceTimersByTimeAsync(CANCEL_RETRY_DELAY_MS - 1);
        expect(cancelMediaDownload).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        await cancelled;

        expect(vi.mocked(cancelMediaDownload).mock.calls).toEqual([["run-1"], ["run-1"]]);
    });

    it("throws the refusal of a run still unknown the second time", async () => {
        vi.mocked(cancelMediaDownload).mockRejectedValue(UNKNOWN_RUN);

        const cancelled = cancelRegisteredRun("run-1");
        const refused = expect(cancelled).rejects.toMatchObject({ code: "INVALID_RUN_ID" });
        await vi.advanceTimersByTimeAsync(CANCEL_RETRY_DELAY_MS);
        await refused;

        expect(cancelMediaDownload).toHaveBeenCalledTimes(2);
    });

    it("throws any other failure at once, without asking again", async () => {
        vi.mocked(cancelMediaDownload).mockRejectedValue({ code: "APP_ERROR", message: "boom" });

        await expect(cancelRegisteredRun("run-1")).rejects.toMatchObject({ code: "APP_ERROR" });

        expect(cancelMediaDownload).toHaveBeenCalledTimes(1);
    });
});
