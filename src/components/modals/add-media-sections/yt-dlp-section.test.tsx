import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { YtDlpSection } from "./yt-dlp-section";
import { renderWithMantine } from "../../../test/test-utils";
import type { YtDlpFormatOption } from "../../../types/media";

function renderYtDlpSection(
    overrides: Partial<ComponentProps<typeof YtDlpSection>> = {}
): ReturnType<typeof renderWithMantine> {
    return renderWithMantine(
        <YtDlpSection
            mediaUrl=""
            cookiesBrowser=""
            cookiesBrowserProfile=""
            cookiesPath=""
            isLocked={false}
            isLoadingYtDlpFormats={false}
            ytDlpFormats={[]}
            selectedYtDlpFormatId=""
            downloadComments={true}
            downloadLiveChat={true}
            onChangeMediaUrl={vi.fn()}
            onChangeCookiesBrowser={vi.fn()}
            onChangeCookiesBrowserProfile={vi.fn()}
            onPickCookiesFile={vi.fn()}
            onClearCookiesPath={vi.fn()}
            onChangeSelectedYtDlpFormatId={vi.fn()}
            onChangeDownloadComments={vi.fn()}
            onChangeDownloadLiveChat={vi.fn()}
            onLoadYtDlpFormats={vi.fn()}
            {...overrides}
        />
    );
}

function createYtDlpFormat(overrides: Partial<YtDlpFormatOption> = {}): YtDlpFormatOption {
    return {
        format_id: "best",
        display_name: "1080p mp4",
        ext: "mp4",
        filesize_bytes: 1024,
        media_type: "video",
        has_video: true,
        has_audio: true,
        height: 1080,
        abr: null,
        tbr: null,
        vcodec: null,
        protocol: null,
        ...overrides,
    };
}

describe("YtDlpSection", () => {
    it("renders url input and load button", () => {
        renderYtDlpSection();

        expect(screen.getByLabelText("Media URL")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Load formats" })).toBeDisabled();
        // The status badges are gone. Two of them reported the state of a checkbox two
        // lines above, and the rest repeated the selects beside them.
        expect(screen.queryByText("0 FORMAT(S)")).not.toBeInTheDocument();
        expect(screen.queryByText("COMMENTS ON")).not.toBeInTheDocument();
        expect(screen.queryByText("NO COOKIES")).not.toBeInTheDocument();
    });

    it("calls media url change handler", () => {
        const onChangeMediaUrl = vi.fn();

        renderYtDlpSection({
            onChangeMediaUrl,
        });

        fireEvent.change(screen.getByLabelText("Media URL"), {
            target: { value: "https://youtube.com/watch?v=abc" },
        });

        expect(onChangeMediaUrl).toHaveBeenCalledWith("https://youtube.com/watch?v=abc");
    });

    it("calls load formats handler", () => {
        const onLoadYtDlpFormats = vi.fn();

        renderYtDlpSection({
            mediaUrl: "https://youtube.com/watch?v=abc",
            onLoadYtDlpFormats,
        });

        fireEvent.click(screen.getByRole("button", { name: "Load formats" }));

        expect(onLoadYtDlpFormats).toHaveBeenCalledTimes(1);
    });

    it("loads formats on Enter when url is filled", () => {
        const onLoadYtDlpFormats = vi.fn();

        renderYtDlpSection({
            mediaUrl: "https://youtube.com/watch?v=abc",
            onLoadYtDlpFormats,
        });

        fireEvent.keyDown(screen.getByLabelText("Media URL"), {
            key: "Enter",
        });

        expect(onLoadYtDlpFormats).toHaveBeenCalledTimes(1);
    });

    it("does not load formats on Enter when url is empty", () => {
        const onLoadYtDlpFormats = vi.fn();

        renderYtDlpSection({
            mediaUrl: "",
            onLoadYtDlpFormats,
        });

        fireEvent.keyDown(screen.getByLabelText("Media URL"), {
            key: "Enter",
        });

        expect(onLoadYtDlpFormats).not.toHaveBeenCalled();
    });

    it("calls format change handler", async () => {
        const onChangeSelectedYtDlpFormatId = vi.fn();

        renderYtDlpSection({
            mediaUrl: "https://youtube.com/watch?v=abc",
            ytDlpFormats: [
                createYtDlpFormat({
                    format_id: "best",
                    display_name: "1080p mp4",
                }),
            ],
            selectedYtDlpFormatId: "",
            onChangeSelectedYtDlpFormatId,
        });

        const availableFormatsInput = screen.getByPlaceholderText("Choose a format");

        fireEvent.mouseDown(availableFormatsInput);
        fireEvent.click(availableFormatsInput);

        const options = await screen.findAllByRole("option", {
            name: /1080p mp4/i,
            hidden: true,
        });

        fireEvent.click(options[options.length - 1]!);

        expect(onChangeSelectedYtDlpFormatId).toHaveBeenCalledWith("best");
    });

    it("shows selected format details", () => {
        renderYtDlpSection({
            mediaUrl: "https://youtube.com/watch?v=abc",
            ytDlpFormats: [
                createYtDlpFormat({
                    format_id: "best",
                    display_name: "1080p mp4",
                }),
            ],
            selectedYtDlpFormatId: "best",
        });

        // The option text carries the stream, resolution, container, codec, bitrate and
        // size, so the only thing worth printing under the select is the id.
        expect(screen.getByText("Format ID: best")).toBeInTheDocument();
        expect(screen.queryByText("Selected format")).not.toBeInTheDocument();

    });

    it("shows manual cookies file controls", () => {
        const onPickCookiesFile = vi.fn();
        const onClearCookiesPath = vi.fn();

        renderYtDlpSection({
            cookiesBrowser: "manual",
            cookiesBrowserProfile: "",
            cookiesPath: "/tmp/cookies.txt",
            onPickCookiesFile,
            onClearCookiesPath,
        });

        expect(screen.getByLabelText("Cookies file")).toHaveValue("/tmp/cookies.txt");
        expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Clear cookies file" })).toBeEnabled();

        fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
        fireEvent.click(screen.getByRole("button", { name: "Clear cookies file" }));

        expect(onPickCookiesFile).toHaveBeenCalledTimes(1);
        expect(onClearCookiesPath).toHaveBeenCalledTimes(1);
    });

    it("shows the browser profile field only once a browser is chosen", () => {
        // Not for the empty selection (nothing to attach a profile to) and not for the manual
        // cookies file (which has its own controls).
        renderYtDlpSection();
        expect(screen.queryByLabelText("Browser profile")).not.toBeInTheDocument();

        renderYtDlpSection({ cookiesBrowser: "manual", cookiesPath: "/tmp/cookies.txt" });
        expect(screen.queryByLabelText("Browser profile")).not.toBeInTheDocument();

        const onChangeCookiesBrowserProfile = vi.fn();
        renderYtDlpSection({
            cookiesBrowser: "firefox",
            cookiesBrowserProfile: "Work",
            onChangeCookiesBrowserProfile,
        });

        const field = screen.getByLabelText("Browser profile");
        expect(field).toHaveValue("Work");

        fireEvent.change(field, { target: { value: "default-release" } });
        expect(onChangeCookiesBrowserProfile).toHaveBeenCalledWith("default-release");
    });

    it("calls comments and live chat change handlers", () => {
        const onChangeDownloadComments = vi.fn();
        const onChangeDownloadLiveChat = vi.fn();

        renderYtDlpSection({
            downloadComments: true,
            downloadLiveChat: true,
            onChangeDownloadComments,
            onChangeDownloadLiveChat,
        });

        fireEvent.click(screen.getByLabelText("Save YouTube comments"));
        fireEvent.click(screen.getByLabelText("Save live chat"));

        expect(onChangeDownloadComments).toHaveBeenCalledWith(false);
        expect(onChangeDownloadLiveChat).toHaveBeenCalledWith(false);
    });
});