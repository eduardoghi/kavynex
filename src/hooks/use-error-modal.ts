import { useCallback, useState } from "react";
import type { ErrorModalController } from "../types/controllers";

export function useErrorModal(): ErrorModalController {
    const [errorOpen, setErrorOpen] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");

    const showError = useCallback((message: string): void => {
        setErrorMessage(message);
        setErrorOpen(true);
    }, []);

    const closeErrorModal = useCallback((): void => {
        setErrorOpen(false);
        setErrorMessage("");
    }, []);

    return {
        errorOpen,
        errorMessage,
        showError,
        closeErrorModal,
    };
}