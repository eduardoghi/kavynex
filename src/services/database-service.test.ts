import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkDatabaseIntegrity } from "./database-service";
import { invokeCommand } from "../lib/tauri-client";
import { TAURI_COMMANDS } from "../constants/tauri-commands";

vi.mock("../lib/tauri-client", () => ({
    invokeCommand: vi.fn(),
    invokeVoid: vi.fn(),
}));

describe("checkDatabaseIntegrity", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("invokes the backend command and resolves true when the database is healthy", async () => {
        vi.mocked(invokeCommand).mockResolvedValueOnce(true);

        const result = await checkDatabaseIntegrity();

        expect(invokeCommand).toHaveBeenCalledWith(TAURI_COMMANDS.CHECK_DATABASE_INTEGRITY);
        expect(result).toBe(true);
    });

    it("resolves false when the integrity check reports a problem", async () => {
        vi.mocked(invokeCommand).mockResolvedValueOnce(false);

        const result = await checkDatabaseIntegrity();

        expect(result).toBe(false);
    });
});
