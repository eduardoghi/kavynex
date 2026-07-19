import { useMemo } from "react";
import { NOOP } from "../utils/noop";

export type ModalLockProps = {
    onClose: () => void;
    closeOnClickOutside: boolean;
    closeOnEscape: boolean;
    withCloseButton: boolean;
};

// Returns the Mantine Modal props that dismiss-lock a modal while a destructive or long-running
// operation is in flight. When `locked`, every dismissal path (Esc, click-outside, close button) is
// disabled and onClose becomes a stable no-op, so the user cannot close the modal mid-flight and
// lose visibility into the operation (or, for an app update, close it and be surprised by a relaunch
// when the download finishes). Each caller decides its own `locked` condition; this centralizes how
// that condition maps onto the Modal so the four props cannot drift apart across modals.
export function useModalLock(locked: boolean, onClose: () => void): ModalLockProps {
    return useMemo(
        () => ({
            onClose: locked ? NOOP : onClose,
            closeOnClickOutside: !locked,
            closeOnEscape: !locked,
            withCloseButton: !locked,
        }),
        [locked, onClose]
    );
}
