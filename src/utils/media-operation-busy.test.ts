import { describe, expect, it } from "vitest";
import {
    isMediaOperationBusy,
    resolveMediaOperationBusyReason,
    type MediaPreparationState,
} from "./media-operation-busy";

const IMPORT_REASON =
    "You cannot change the library folder while media is being imported or downloaded.";
const PREPARATION_REASON =
    "You cannot change the library folder while media preparation is in progress.";

function createState(overrides: Partial<MediaPreparationState> = {}): MediaPreparationState {
    return {
        isAddingMedia: false,
        isYtDlpRunning: false,
        isCancellingYtDlp: false,
        isGeneratingThumb: false,
        isLoadingYtDlpFormats: false,
        ...overrides,
    };
}

describe("isMediaOperationBusy", () => {
    it("returns false when no operation is running", () => {
        expect(isMediaOperationBusy(createState())).toBe(false);
    });

    it.each([
        "isAddingMedia",
        "isYtDlpRunning",
        "isCancellingYtDlp",
        "isGeneratingThumb",
        "isLoadingYtDlpFormats",
    ] as const)("returns true when only %s is set", (flag) => {
        expect(isMediaOperationBusy(createState({ [flag]: true }))).toBe(true);
    });
});

describe("resolveMediaOperationBusyReason", () => {
    it("returns an empty reason when no operation is running", () => {
        expect(resolveMediaOperationBusyReason(createState())).toBe("");
    });

    it.each([
        "isAddingMedia",
        "isYtDlpRunning",
        "isCancellingYtDlp",
    ] as const)("returns the import reason when only %s is set", (flag) => {
        expect(resolveMediaOperationBusyReason(createState({ [flag]: true }))).toBe(
            IMPORT_REASON
        );
    });

    it.each([
        "isGeneratingThumb",
        "isLoadingYtDlpFormats",
    ] as const)("returns the preparation reason when only %s is set", (flag) => {
        expect(resolveMediaOperationBusyReason(createState({ [flag]: true }))).toBe(
            PREPARATION_REASON
        );
    });

    it("prefers the import reason when both groups are busy", () => {
        expect(
            resolveMediaOperationBusyReason(
                createState({ isYtDlpRunning: true, isGeneratingThumb: true })
            )
        ).toBe(IMPORT_REASON);
    });
});
