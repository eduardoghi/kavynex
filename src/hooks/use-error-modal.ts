import { useCallback, useState } from "react";
import type { ErrorModalVariant } from "../components/modals/error-modal";
import type { ErrorModalController } from "../types/controllers";
import { useMemoObject } from "./use-memo-object";

export function useErrorModal(): ErrorModalController {
    const [errorOpen, setErrorOpen] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [errorVariant, setErrorVariant] = useState<ErrorModalVariant>("error");

    const showError = useCallback((message: string): void => {
        setErrorVariant("error");
        setErrorMessage(message);
        setErrorOpen(true);
    }, []);

    // Neutral, non-alarming message (e.g. "no comments were found") - shown in the same modal
    // as errors but styled as a notice, so an expected outcome is not dressed up as a failure.
    const showNotice = useCallback((message: string): void => {
        setErrorVariant("notice");
        setErrorMessage(message);
        setErrorOpen(true);
    }, []);

    const closeErrorModal = useCallback((): void => {
        setErrorOpen(false);
        setErrorMessage("");
    }, []);

    // Memoized so consumers depending on the whole object identity don't re-render unnecessarily.
    return useMemoObject({
        errorOpen,
        errorMessage,
        errorVariant,
        showError,
        showNotice,
        closeErrorModal,
    });
}