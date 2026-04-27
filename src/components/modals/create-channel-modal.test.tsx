import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateChannelModal } from "./create-channel-modal";
import { renderWithMantine } from "../../test/test-utils";

describe("CreateChannelModal", () => {
    it("renders modal fields", () => {
        renderWithMantine(
            <CreateChannelModal
                opened
                onClose={vi.fn()}
                channelName=""
                youtubeHandle=""
                avatarMode="none"
                avatarPath=""
                loading={false}
                onChangeChannelName={vi.fn()}
                onChangeYoutubeHandle={vi.fn()}
                onChangeAvatarMode={vi.fn()}
                onPickAvatar={vi.fn()}
                onClearAvatar={vi.fn()}
                onCreate={vi.fn()}
            />
        );

        expect(screen.getByText("New channel")).toBeInTheDocument();
        expect(screen.getByLabelText(/Name/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/YouTube handle/i)).toBeInTheDocument();
        expect(screen.getByText(/Channel avatar/i)).toBeInTheDocument();
    });

    it("disables create button when fields are empty", () => {
        renderWithMantine(
            <CreateChannelModal
                opened
                onClose={vi.fn()}
                channelName=""
                youtubeHandle=""
                avatarMode="none"
                avatarPath=""
                loading={false}
                onChangeChannelName={vi.fn()}
                onChangeYoutubeHandle={vi.fn()}
                onChangeAvatarMode={vi.fn()}
                onPickAvatar={vi.fn()}
                onClearAvatar={vi.fn()}
                onCreate={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    });

    it("enables create button when fields are filled", () => {
        renderWithMantine(
            <CreateChannelModal
                opened
                onClose={vi.fn()}
                channelName="Canal A"
                youtubeHandle="@canala"
                avatarMode="none"
                avatarPath=""
                loading={false}
                onChangeChannelName={vi.fn()}
                onChangeYoutubeHandle={vi.fn()}
                onChangeAvatarMode={vi.fn()}
                onPickAvatar={vi.fn()}
                onClearAvatar={vi.fn()}
                onCreate={vi.fn()}
            />
        );

        expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
    });

    it("calls change handlers", () => {
        const onChangeChannelName = vi.fn();
        const onChangeYoutubeHandle = vi.fn();

        renderWithMantine(
            <CreateChannelModal
                opened
                onClose={vi.fn()}
                channelName=""
                youtubeHandle=""
                avatarMode="none"
                avatarPath=""
                loading={false}
                onChangeChannelName={onChangeChannelName}
                onChangeYoutubeHandle={onChangeYoutubeHandle}
                onChangeAvatarMode={vi.fn()}
                onPickAvatar={vi.fn()}
                onClearAvatar={vi.fn()}
                onCreate={vi.fn()}
            />
        );

        fireEvent.change(screen.getByLabelText(/Name/i), {
            target: { value: "Canal A" },
        });

        fireEvent.change(screen.getByLabelText(/YouTube handle/i), {
            target: { value: "@canala" },
        });

        expect(onChangeChannelName).toHaveBeenCalledWith("Canal A");
        expect(onChangeYoutubeHandle).toHaveBeenCalledWith("@canala");
    });

    it("calls create action on button click", () => {
        const onCreate = vi.fn();

        renderWithMantine(
            <CreateChannelModal
                opened
                onClose={vi.fn()}
                channelName="Canal A"
                youtubeHandle="@canala"
                avatarMode="none"
                avatarPath=""
                loading={false}
                onChangeChannelName={vi.fn()}
                onChangeYoutubeHandle={vi.fn()}
                onChangeAvatarMode={vi.fn()}
                onPickAvatar={vi.fn()}
                onClearAvatar={vi.fn()}
                onCreate={onCreate}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        expect(onCreate).toHaveBeenCalled();
    });

    it("calls create action on form submit when valid", () => {
        const onCreate = vi.fn();

        renderWithMantine(
            <CreateChannelModal
                opened
                onClose={vi.fn()}
                channelName="Canal A"
                youtubeHandle="@canala"
                avatarMode="none"
                avatarPath=""
                loading={false}
                onChangeChannelName={vi.fn()}
                onChangeYoutubeHandle={vi.fn()}
                onChangeAvatarMode={vi.fn()}
                onPickAvatar={vi.fn()}
                onClearAvatar={vi.fn()}
                onCreate={onCreate}
            />
        );

        const createButton = screen.getByRole("button", { name: "Create" });
        const form = createButton.closest("form");

        expect(form).not.toBeNull();

        fireEvent.submit(form!);

        expect(onCreate).toHaveBeenCalledTimes(1);
    });

    it("does not call create when loading", () => {
        const onCreate = vi.fn();

        renderWithMantine(
            <CreateChannelModal
                opened
                onClose={vi.fn()}
                channelName="Canal A"
                youtubeHandle="@canala"
                avatarMode="none"
                avatarPath=""
                loading
                onChangeChannelName={vi.fn()}
                onChangeYoutubeHandle={vi.fn()}
                onChangeAvatarMode={vi.fn()}
                onPickAvatar={vi.fn()}
                onClearAvatar={vi.fn()}
                onCreate={onCreate}
            />
        );

        expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    });
});