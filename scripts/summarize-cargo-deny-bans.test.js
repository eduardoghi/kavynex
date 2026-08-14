import { describe, expect, it } from "vitest";
import { parseBanDiagnostics, renderBansSummary } from "./summarize-cargo-deny-bans.js";

// One `duplicate` diagnostic in the shape cargo-deny 0.20.2 actually emits, minus the `graphs`
// field, which the real line carries (and which is enormous: the full dependency path to every
// occurrence) but which this script never reads. `message` is passed separately from `versions`
// so a test can make the two disagree, which is how the "read the span, not the prose" contract
// gets pinned.
const duplicate = (name, versions, message = `found ${versions.length} duplicate entries for crate '${name}'`) =>
    JSON.stringify({
        type: "diagnostic",
        fields: {
            code: "duplicate",
            severity: "warning",
            message,
            graphs: [],
            labels: [
                {
                    column: 1,
                    line: 24,
                    message: "lock entries",
                    span: versions
                        .map(
                            (version) =>
                                `${name} ${version} registry+https://github.com/rust-lang/crates.io-index`
                        )
                        .join("\n"),
                },
            ],
        },
    });

const summary = (warnings) =>
    JSON.stringify({
        type: "summary",
        fields: { bans: { errors: 0, helps: 0, notes: 0, warnings } },
    });

describe("parseBanDiagnostics", () => {
    it("reads the crate name and every version out of one duplicate diagnostic", () => {
        const { duplicates } = parseBanDiagnostics(duplicate("base64", ["0.21.7", "0.22.1"]));

        expect(duplicates).toEqual([{ name: "base64", versions: ["0.21.7", "0.22.1"] }]);
    });

    it("takes the crate from the label span rather than from the diagnostic message", () => {
        // The message is English prose and is free to be reworded upstream; the span is the data
        // being reported. Making the two disagree is the only way to prove which one is read. A
        // parser that scraped the message would answer "somethingelse" here.
        const { duplicates } = parseBanDiagnostics(
            duplicate("base64", ["0.21.7", "0.22.1"], "found 2 duplicate entries for crate 'somethingelse'")
        );

        expect(duplicates).toEqual([{ name: "base64", versions: ["0.21.7", "0.22.1"] }]);
    });

    it("handles a crate resolving to more than two versions", () => {
        // `windows-sys` really does appear five times in this tree, so the two-version case is not
        // the only shape the table has to render.
        const { duplicates } = parseBanDiagnostics(
            duplicate("windows-sys", ["0.48.0", "0.52.0", "0.59.0", "0.60.2", "0.61.1"])
        );

        expect(duplicates[0].versions).toHaveLength(5);
    });

    it("reads cargo-deny's own warning count from the trailing summary diagnostic", () => {
        const { reportedWarnings } = parseBanDiagnostics(
            [duplicate("base64", ["0.21.7", "0.22.1"]), summary(38)].join("\n")
        );

        expect(reportedWarnings).toBe(38);
    });

    it("reports no count at all when the output carries no summary diagnostic", () => {
        // Distinct from a count of zero: one means "cargo-deny said the tree is clean", the other
        // means "this was not cargo-deny output". The renderer says different things about them.
        const { reportedWarnings } = parseBanDiagnostics(duplicate("base64", ["0.21.7", "0.22.1"]));

        expect(reportedWarnings).toBeNull();
    });

    it("counts lines that are not JSON instead of failing on them", () => {
        // cargo writes its own progress to the same stream on a cold runner, so this is the
        // ordinary case rather than a corrupt input, but a stream that is *entirely* noise is how
        // a mistyped invocation looks, and the count is what makes that visible.
        const { duplicates, unparsedLines } = parseBanDiagnostics(
            [
                "    Updating crates.io index",
                duplicate("base64", ["0.21.7", "0.22.1"]),
                "     Locking 3 packages",
                summary(1),
            ].join("\n")
        );

        expect(duplicates).toHaveLength(1);
        expect(unparsedLines).toBe(2);
    });

    it("ignores a bans diagnostic that is not a duplicate finding", () => {
        // `bans` also covers skipped and denied crates, which arrive as diagnostics under their own
        // codes. Counting one of those as a duplicate would inflate the headline number.
        const { duplicates } = parseBanDiagnostics(
            [
                JSON.stringify({
                    type: "diagnostic",
                    fields: { code: "banned", severity: "error", message: "detected banned crate", labels: [] },
                }),
                summary(0),
            ].join("\n")
        );

        expect(duplicates).toEqual([]);
    });

    it("skips a duplicate diagnostic whose labels carry no lock entries", () => {
        // Better to under-report one finding than to put a nameless row in the table; the
        // summary-count cross-check is what surfaces that something went unread.
        const { duplicates } = parseBanDiagnostics(
            JSON.stringify({
                type: "diagnostic",
                fields: { code: "duplicate", severity: "warning", message: "found 2", labels: [] },
            })
        );

        expect(duplicates).toEqual([]);
    });

    it("orders the findings worst-first so the costliest crates head the table", () => {
        const { duplicates } = parseBanDiagnostics(
            [
                duplicate("aaa-two-versions", ["1.0.0", "2.0.0"]),
                duplicate("zzz-three-versions", ["1.0.0", "2.0.0", "3.0.0"]),
                duplicate("bbb-two-versions", ["1.0.0", "2.0.0"]),
            ].join("\n")
        );

        expect(duplicates.map((crate) => crate.name)).toEqual([
            "zzz-three-versions",
            "aaa-two-versions",
            "bbb-two-versions",
        ]);
    });
});

describe("renderBansSummary", () => {
    it("reports a clean tree only when cargo-deny itself reported no warnings", () => {
        const markdown = renderBansSummary({ duplicates: [], reportedWarnings: 0 });

        expect(markdown).toContain("resolves to a single version");
    });

    it("says it could not read the output when no summary diagnostic was present", () => {
        // The guard this whole report rests on. Without it, an output shape this script no longer
        // understands renders exactly like a clean tree. Good news that is not true, in a summary
        // whose only value is being believed at a glance.
        const markdown = renderBansSummary({
            duplicates: [],
            reportedWarnings: null,
            unparsedLines: 4,
        });

        expect(markdown).toContain("Could not read cargo-deny's output");
        expect(markdown).toContain("4 unrecognized line(s)");
        expect(markdown).not.toContain("resolves to a single version");
    });

    it("says the output shape changed when warnings were reported but none could be read", () => {
        // The other half of the same guard, and the likelier one: cargo-deny still runs and still
        // warns, but `duplicate` was renamed or `labels` reshaped, so the parse yields nothing.
        const markdown = renderBansSummary({ duplicates: [], reportedWarnings: 38 });

        expect(markdown).toContain("output shape has probably changed");
        expect(markdown).toContain("summarize-cargo-deny-bans.js");
        expect(markdown).not.toContain("resolves to a single version");
    });

    it("counts the extra lock entries rather than only the crates", () => {
        // Five versions of one crate cost four times what two versions of it do, so the crate count
        // alone understates the surface. 1 extra + 2 extra = 3.
        const markdown = renderBansSummary({
            duplicates: [
                { name: "two", versions: ["1.0.0", "2.0.0"] },
                { name: "three", versions: ["1.0.0", "2.0.0", "3.0.0"] },
            ],
            reportedWarnings: 2,
        });

        expect(markdown).toContain("**2** crate(s)");
        expect(markdown).toContain("**3** extra lock entries");
    });

    it("uses the singular when exactly one extra entry exists", () => {
        const markdown = renderBansSummary({
            duplicates: [{ name: "two", versions: ["1.0.0", "2.0.0"] }],
            reportedWarnings: 1,
        });

        expect(markdown).toContain("**1** extra lock entry");
    });

    it("renders one table row per crate with all of its versions", () => {
        const markdown = renderBansSummary({
            duplicates: [{ name: "base64", versions: ["0.21.7", "0.22.1"] }],
            reportedWarnings: 1,
        });

        expect(markdown).toContain("| `base64` | `0.21.7`, `0.22.1` |");
    });

    it("notes a disagreement between the reported and the read warning counts", () => {
        const markdown = renderBansSummary({
            duplicates: [{ name: "base64", versions: ["0.21.7", "0.22.1"] }],
            reportedWarnings: 5,
        });

        expect(markdown).toContain("cargo-deny reported 5");
        expect(markdown).toContain("1 of them were read");
    });

    it("stays silent about the counts when they agree", () => {
        const markdown = renderBansSummary({
            duplicates: [{ name: "base64", versions: ["0.21.7", "0.22.1"] }],
            reportedWarnings: 1,
        });

        expect(markdown).not.toContain("cargo-deny reported");
    });

    it("does not claim a count cargo-deny never gave when findings were read anyway", () => {
        // A missing summary line with findings present is not worth a warning banner: the table is
        // the answer, and there is no second number to reconcile it against.
        const markdown = renderBansSummary({
            duplicates: [{ name: "base64", versions: ["0.21.7", "0.22.1"] }],
            reportedWarnings: null,
        });

        expect(markdown).not.toContain("cargo-deny reported");
        expect(markdown).toContain("| `base64` |");
    });
});
