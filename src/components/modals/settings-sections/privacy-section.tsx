import { Group, Stack, Switch, Title } from "@mantine/core";
import { Shield } from "lucide-react";

type PrivacySectionProps = {
    loadRemoteImages: boolean;
    onChangeLoadRemoteImages: (loadRemoteImages: boolean) => void;
};

export function PrivacySection({
    loadRemoteImages,
    onChangeLoadRemoteImages,
}: PrivacySectionProps): JSX.Element {
    return (
        <Stack gap="xs">
            <Group gap="sm">
                <Shield size={18} />
                <Title order={4}>Privacy</Title>
            </Group>

            <Switch
                checked={loadRemoteImages}
                onChange={(event) => onChangeLoadRemoteImages(event.currentTarget.checked)}
                label="Load comment and live chat images from Google"
                description="When on, author avatars, custom emojis and super-sticker images are fetched from Google's servers as you open saved comments and live chat. Turn off to show monograms and hide those images so viewing saved media stays fully offline."
            />
        </Stack>
    );
}
