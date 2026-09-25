import { Group, Radio, Stack, Title } from "@mantine/core";
import { Settings2 } from "lucide-react";
import { useId } from "react";
import type { ImportMode } from "../../../types/settings";
import { toUnionValue } from "../../../utils/guards";

const IMPORT_MODES = ["copy", "move"] as const;

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
    const titleId = useId();

    return (
        <Stack gap="xs">
            <Group gap="sm">
                <Settings2 size={18} />
                <Title id={titleId} order={3} size="h4">
                    Import behavior
                </Title>
            </Group>

            <Radio.Group
                // Mantine puts aria-label and aria-labelledby on its Input.Wrapper root, not on the
                // inner element with role="radiogroup", so neither names the group. That element
                // does take aria-labelledby from the wrapper's label id, and labelProps.id sets it,
                // so pointing it at the visible title names the group without rendering a second
                // label.
                labelProps={{ id: titleId }}
                value={importMode}
                onChange={(value) =>
                    onChangeImportMode(toUnionValue(value, IMPORT_MODES, importMode))
                }
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
