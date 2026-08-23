import { Group, Radio, Stack, Text, Title } from "@mantine/core";
import { Accessibility } from "lucide-react";
import { MOTION_PREFERENCES, type MotionPreference } from "../../../utils/motion-preference";
import { toUnionValue } from "../../../utils/guards";

type MotionSectionProps = {
    motionPreference: MotionPreference;
    onChangeMotionPreference: (preference: MotionPreference) => void;
};

// Three choices rather than a switch, because the default is not "on" or "off" but "whatever the
// operating system says", and a switch has no way to show that the app is deferring rather than
// deciding. The labels say what each one does to the screen, not what the preference is called.
export function MotionSection({
    motionPreference,
    onChangeMotionPreference,
}: MotionSectionProps): JSX.Element {
    return (
        <Stack gap="xs">
            <Group gap="sm">
                <Accessibility size={18} />
                <Title order={4}>Motion</Title>
            </Group>

            <Text size="sm" c="dimmed">
                Transitions and animations: the cards lifting on hover, modals sliding in, the
                striped download bar. Reducing them helps if motion on screen makes you uncomfortable.
            </Text>

            <Radio.Group
                value={motionPreference}
                onChange={(value) =>
                    onChangeMotionPreference(
                        toUnionValue(value, MOTION_PREFERENCES, motionPreference)
                    )
                }
            >
                <Stack gap="xs">
                    <Radio
                        value="system"
                        label="Follow the system setting"
                        description="Uses your operating system's reduce motion preference, and follows it if it changes."
                    />

                    <Radio value="reduce" label="Reduce motion" />

                    <Radio value="full" label="Full motion" />
                </Stack>
            </Radio.Group>
        </Stack>
    );
}
