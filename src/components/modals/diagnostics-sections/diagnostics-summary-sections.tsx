import { Divider } from "@mantine/core";
import type { DiagnosticsSummary } from "../../../types/diagnostics";
import { DiagnosticsApplicationSection } from "./diagnostics-application-section";
import { DiagnosticsDatabaseSection } from "./diagnostics-database-section";
import { DiagnosticsLiveChatIntegritySection } from "./diagnostics-live-chat-integrity-section";
import { DiagnosticsLiveChatSection } from "./diagnostics-live-chat-section";
import { DiagnosticsOverviewHeader } from "./diagnostics-overview";
import { DiagnosticsPhysicalIntegritySection } from "./diagnostics-physical-integrity-section";
import { DiagnosticsToolsAndLibrarySection } from "./diagnostics-tools-and-library-section";

type DiagnosticsSummarySectionsProps = {
    summary: DiagnosticsSummary;
};

// The report, in reading order. Each section is its own module and takes only the slice of the
// diagnostics it renders, so a metric added to one of them is a change to a file of fifty lines
// rather than to one of five hundred, and a section can be rendered on its own in a test with
// only the data it reads. This component is the order and the rules between them, nothing else.
export function DiagnosticsSummarySections({
    summary,
}: DiagnosticsSummarySectionsProps): JSX.Element {
    const diagnostics = summary.diagnostics;

    return (
        <>
            <DiagnosticsOverviewHeader overview={summary.overview} />

            <Divider />

            <DiagnosticsApplicationSection
                appVersion={diagnostics.appVersion}
                platform={diagnostics.platform}
                arch={diagnostics.arch}
                importMode={diagnostics.importMode}
            />

            <Divider />

            <DiagnosticsToolsAndLibrarySection
                externalTools={diagnostics.externalTools}
                libraryPath={diagnostics.libraryPath}
                librarySummary={diagnostics.librarySummary}
            />

            <Divider />

            <DiagnosticsDatabaseSection stats={diagnostics.mediaRepositoryStats} />

            <Divider />

            <DiagnosticsLiveChatSection
                liveChatStorage={diagnostics.liveChatStorage}
                stats={diagnostics.mediaRepositoryStats}
            />

            <Divider />

            <DiagnosticsPhysicalIntegritySection
                libraryIntegrity={diagnostics.libraryIntegrity}
                libraryPath={diagnostics.libraryPath}
            />

            <Divider />

            <DiagnosticsLiveChatIntegritySection liveChatIntegrity={diagnostics.liveChatIntegrity} />
        </>
    );
}
