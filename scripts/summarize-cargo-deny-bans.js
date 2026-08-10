// Renders the duplicate-version findings from `cargo deny check bans` as a GitHub step summary.
//
// This is a reporter, not a gate. `src-tauri/deny.toml` sets `multiple-versions = "warn"`
// deliberately - duplicate versions in a transitive tree this size are ordinary and not worth
// failing a build over - and what that setting's own comment promises is that they are surfaced
// "so the bloat/audit surface stays visible". That part was not true: the warnings went to the log
// of a job that passes, and nobody opens the log of a green job. This turns them into a number on
// the run's summary page, which is where the promise is actually kept.
//
// It must never turn the audit red over what it reads. A reporting step that can fail the job it
// reports on would be strictly worse than the log line it replaces, so an output this script cannot
// make sense of is described *in the summary* rather than raised. The one exception is being wired
// up wrong (no argument, unreadable file), which exits non-zero on purpose - see the bottom of the
// file for why that asymmetry is the right way round.
//
// Run locally (needs cargo-deny installed, same pinned version as CI):
//     cargo deny --manifest-path src-tauri/Cargo.toml --format json check bans 2> deny-bans.json
//     node scripts/summarize-cargo-deny-bans.js deny-bans.json
//
// The `2>` is not a typo. cargo-deny writes its JSON diagnostics to stderr and leaves stdout empty.

import { readFileSync } from "fs";

// The crate name and its versions, read out of one `duplicate` diagnostic.
//
// Both come from the diagnostic's label spans, which are data - one lock entry per line, in
// `<name> <version> <source>` form - and never from `fields.message`, which is English prose
// ("found 2 duplicate entries for crate 'base64'"). A message is free to be reworded between
// cargo-deny releases without that being a breaking change; the span is the thing being reported.
//
// Returns null for a diagnostic whose labels carry nothing usable, so the caller can count it as
// unread rather than invent an entry for it.
function readDuplicateCrate(fields) {
    const entries = (fields.labels ?? [])
        .flatMap((label) => String(label.span ?? "").split("\n"))
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => entry.split(/\s+/));

    const name = entries[0]?.[0];
    const versions = entries.map((entry) => entry[1]).filter(Boolean);

    if (!name || versions.length === 0) {
        return null;
    }

    return { name, versions };
}

// Reads the newline-delimited JSON `cargo deny --format json check bans` writes to stderr.
//
// Returns the duplicate-version findings, cargo-deny's own warning count from its trailing
// `summary` diagnostic, and how many lines could not be parsed as JSON at all. The last two exist
// for the same reason and it is the important one: if a future cargo-deny renames the `duplicate`
// code or reshapes `labels`, the parse here yields nothing, and a summary built from that alone
// would read "every crate resolves to a single version" - good news that is not true, in a report
// whose whole value is being believed at a glance. Carrying the tool's own count lets the renderer
// tell "clean" apart from "no longer understood".
//
// Findings are ordered worst-first (most versions, then name) so the crates actually costing
// something are at the top of the table rather than wherever the graph walk happened to emit them.
export function parseBanDiagnostics(ndjson) {
    const duplicates = [];
    let reportedWarnings = null;
    let unparsedLines = 0;

    for (const line of ndjson.split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        let entry;

        try {
            entry = JSON.parse(trimmed);
        } catch {
            // cargo writes its own progress ("Updating crates.io index") to this same stream on a
            // cold runner, so a non-JSON line is expected rather than alarming. Counting them is
            // what keeps a stream that is *entirely* noise - the shape a mistyped invocation
            // produces - distinguishable from a genuinely clean tree.
            unparsedLines += 1;
            continue;
        }

        if (entry?.type === "summary") {
            const warnings = entry.fields?.bans?.warnings;

            if (typeof warnings === "number") {
                reportedWarnings = warnings;
            }

            continue;
        }

        if (entry?.type !== "diagnostic" || entry.fields?.code !== "duplicate") {
            continue;
        }

        const crate = readDuplicateCrate(entry.fields);

        if (crate) {
            duplicates.push(crate);
        }
    }

    duplicates.sort(
        (left, right) =>
            right.versions.length - left.versions.length || left.name.localeCompare(right.name)
    );

    return { duplicates, reportedWarnings, unparsedLines };
}

// The markdown body for `$GITHUB_STEP_SUMMARY`. Pure, so every branch below - especially the two
// that describe an output this script could not read - is one call from a test.
export function renderBansSummary({ duplicates, reportedWarnings = null, unparsedLines = 0 }) {
    const lines = ["### Duplicate dependency versions", ""];

    if (duplicates.length === 0) {
        // Three ways to have nothing to show, and only one of them is good news. Rendering the same
        // "all clean" line for all three is the failure this whole report would be worth least for.
        if (reportedWarnings === null) {
            const noise = unparsedLines > 0 ? ` (${unparsedLines} unrecognized line(s))` : "";

            lines.push(
                `Could not read cargo-deny's output: it carried no \`summary\` diagnostic${noise}. ` +
                    "The `bans` check itself still gated this run - only this report is missing."
            );
        } else if (reportedWarnings > 0) {
            lines.push(
                `cargo-deny reported ${reportedWarnings} \`bans\` warning(s), but none of them could be read ` +
                    "as a duplicate-version finding. Its output shape has probably changed; update " +
                    "`scripts/summarize-cargo-deny-bans.js`."
            );
        } else {
            lines.push("Every crate in `src-tauri/Cargo.lock` resolves to a single version.");
        }

        return lines.join("\n");
    }

    // What a duplicate actually costs is the entries beyond the first, not the crate count: five
    // versions of one crate is four times the compile and audit surface of two versions of it.
    const extraEntries = duplicates.reduce(
        (total, { versions }) => total + versions.length - 1,
        0
    );

    lines.push(
        `**${duplicates.length}** crate(s) resolve to more than one version, costing **${extraEntries}** ` +
            `extra lock ${extraEntries === 1 ? "entry" : "entries"}.`,
        "",
        "`multiple-versions` is `warn` in `src-tauri/deny.toml` on purpose: duplicates are ordinary in a " +
            "transitive tree this size and are not worth failing a build over. This is the number that " +
            "setting exists to keep visible.",
        ""
    );

    if (reportedWarnings !== null && reportedWarnings !== duplicates.length) {
        // Not necessarily wrong - `bans` also covers skipped/denied crates, which warn under their
        // own codes - but a gap worth naming rather than leaving the reader to reconcile two
        // numbers that came from the same run.
        lines.push(
            `> cargo-deny reported ${reportedWarnings} \`bans\` warning(s); ${duplicates.length} of them were read ` +
                "as duplicate-version findings. The difference is either another `bans` rule firing or a " +
                "shape this script does not handle.",
            ""
        );
    }

    lines.push(
        "<details><summary>Crates with more than one version</summary>",
        "",
        "| Crate | Versions |",
        "| --- | --- |",
        ...duplicates.map(
            ({ name, versions }) =>
                `| \`${name}\` | ${versions.map((version) => `\`${version}\``).join(", ")} |`
        ),
        "",
        "</details>"
    );

    return lines.join("\n");
}

// Only run when invoked as a script, so the exports above stay unit-testable (importing this file
// must not read files or exit).
//
// This is the one place that exits non-zero, and the asymmetry with everything above is deliberate.
// A missing argument or an unreadable file is a wiring mistake, not a surprising input - and a
// mis-wired reporter fails in the worst possible way, printing nothing forever while the step stays
// green and the summary silently reads as a clean tree. That belongs loud. What must stay quiet is
// only the part that judges cargo-deny's *content*, which is handled in the renderer above.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    const inputPath = process.argv[2];

    if (!inputPath) {
        console.error(
            "Usage: node scripts/summarize-cargo-deny-bans.js <cargo deny --format json check bans output>"
        );
        process.exit(1);
    }

    console.log(renderBansSummary(parseBanDiagnostics(readFileSync(inputPath, "utf8"))));
}
