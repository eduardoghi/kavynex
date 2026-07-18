import { Group, Radio, Stack, Title } from "@mantine/core";
import { Settings2 } from "lucide-react";
import type { ImportMode } from "../../../types/settings";

type ImportBehaviorSectionProps = {
    importMode: ImportMode;
    onChangeImportMode: (mode: ImportMode) => void;
    isMigratingLibraryPath: boolean;
};

export function ImportBehaviorSection({
    importMode,
    onChangeImportMode,
    isMigratingLibraryPath,
}: ImportBehaviorSectionProps): JSX.Element {
    return (
        <Stack gap="xs">
            <Group gap="sm">
                <Settings2 size={18} />
                <Title order={4}>Import behavior</Title>
            </Group>

            <Radio.Group
                // Names the group for assistive tech; the visible <Title> above is not
                // programmatically associated with it.
                aria-label="Import behavior"
                value={importMode}
                onChange={(value) => onChangeImportMode(value as ImportMode)}
            >
                <Stack gap="xs">
                    <Radio
                        value="copy"
                        label="Copy files into the library folder"
                        disabled={isMigratingLibraryPath}
                    />

                    <Radio
                        value="move"
                        label="Move files into the library folder"
                        disabled={isMigratingLibraryPath}
                    />
                </Stack>
            </Radio.Group>
        </Stack>
    );
}
