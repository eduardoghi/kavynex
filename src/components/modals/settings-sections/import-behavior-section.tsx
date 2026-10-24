import { Group, Radio, Stack, Title, VisuallyHidden } from "@mantine/core";
import { Settings2 } from "lucide-react";
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
    return (
        <Stack gap="xs">
            <Group gap="sm">
                <Settings2 size={18} />
                <Title order={3} size="h4">
                    Import behavior
                </Title>
            </Group>

            <Radio.Group
                // Mantine puts aria-label and aria-labelledby on its Input.Wrapper root, not on the
                // inner element with role="radiogroup", so neither names the group. That element is
                // labelled by the wrapper's own label, and only when one is rendered (from Mantine
                // 9.7 on, a label id alone does not reach it). So the label is the title's text,
                // visually hidden, with `display: contents` so its box takes no space under the
                // visible title above.
                label={<VisuallyHidden>Import behavior</VisuallyHidden>}
                labelProps={{ style: { display: "contents" } }}
                value={importMode}
                onChange={(value) =>
                    onChangeImportMode(toUnionValue(value, IMPORT_MODES, importMode))
                }
            >
                <Stack gap="xs">
                    <Radio
                        value="copy"
                        label="Copy files into the library folder"
                        description="The original file stays where it is."
                        disabled={isMigratingLibraryPath}
                    />

                    <Radio
                        value="move"
                        label="Move files into the library folder"
                        description="The original file is removed from its folder once the media is added to the library."
                        disabled={isMigratingLibraryPath}
                    />
                </Stack>
            </Radio.Group>
        </Stack>
    );
}
