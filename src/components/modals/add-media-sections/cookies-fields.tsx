import { ActionIcon, Group, Select, TextInput } from "@mantine/core";
import { FileText, X } from "lucide-react";
import { COOKIES_BROWSER_SELECT_OPTIONS } from "../../../constants/cookies-browsers";
import { AppButton } from "../../ui/app-button";

type CookiesFieldsProps = {
    // A browser, "manual" for a cookies file, or "" for none (see COOKIES_BROWSER_SELECT_OPTIONS).
    cookiesBrowser: string;
    cookiesBrowserProfile: string;
    cookiesPath: string;
    isLocked: boolean;
    onChangeCookiesBrowser: (value: string) => void;
    onChangeCookiesBrowserProfile: (value: string) => void;
    onPickCookiesFile: () => void | Promise<void>;
    onClearCookiesPath: () => void;
};

// How yt-dlp signs in to YouTube, for the add-media form and a batch import alike. A browser to
// read the cookies from, with an optional profile, or a cookies.txt file.
export function CookiesFields({
    cookiesBrowser,
    cookiesBrowserProfile,
    cookiesPath,
    isLocked,
    onChangeCookiesBrowser,
    onChangeCookiesBrowserProfile,
    onPickCookiesFile,
    onClearCookiesPath,
}: CookiesFieldsProps): JSX.Element {
    const isManualCookies = cookiesBrowser === "manual";
    const isBrowserCookies = cookiesBrowser !== "" && !isManualCookies;

    return (
        <>
            <Select
                label="YouTube authentication"
                placeholder="Optional"
                value={cookiesBrowser || null}
                onChange={(value) => onChangeCookiesBrowser(value ?? "")}
                data={COOKIES_BROWSER_SELECT_OPTIONS}
                clearable
                disabled={isLocked}
                // What choosing a browser actually does, said where the choice is made. The Windows
                // note is yt-dlp's limitation (Chrome 127+ app-bound cookie encryption, yt-dlp issue
                // 10927), and the ban risk is the one yt-dlp's own YouTube documentation warns about.
                description="Use this only when YouTube asks for authentication. Downloads are made as the signed-in account, and YouTube can restrict or ban an account used this way, so prefer a secondary one. On Windows, Chrome and Edge cookies often cannot be read. Firefox or a cookies file works more reliably."
            />

            {/* Only needed when the browser has more than one profile, so it appears only once a
                browser is chosen and stays optional. A single field carries yt-dlp's whole
                BROWSER[+KEYRING][:PROFILE][::CONTAINER] grammar (the browser is prepended), since a
                second control for the keyring would serve the rarest case of the three. */}
            {isBrowserCookies && (
                <TextInput
                    label="Browser profile"
                    placeholder="Optional. Profile name or path, for example default-release"
                    value={cookiesBrowserProfile}
                    onChange={(event) => onChangeCookiesBrowserProfile(event.currentTarget.value)}
                    disabled={isLocked}
                    description="Leave empty to use the browser's default profile. Add ::Name for a Firefox container, or start with +keyring (for example +gnomekeyring:Default) on Linux."
                />
            )}

            {isManualCookies && (
                <Group align="end" wrap="nowrap">
                    <TextInput
                        label="Cookies file"
                        placeholder="Choose a cookies.txt file"
                        value={cookiesPath}
                        leftSection={<FileText size={16} />}
                        readOnly
                        style={{ flex: 1 }}
                    />

                    <AppButton
                        type="button"
                        appVariant="secondary"
                        onClick={() => void onPickCookiesFile()}
                        disabled={isLocked}
                    >
                        Choose file
                    </AppButton>

                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="lg"
                        aria-label="Clear cookies file"
                        onClick={onClearCookiesPath}
                        disabled={isLocked || !cookiesPath.trim()}
                    >
                        <X size={18} />
                    </ActionIcon>
                </Group>
            )}
        </>
    );
}
