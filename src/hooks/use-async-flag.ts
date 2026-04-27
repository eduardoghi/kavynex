import { useCallback, useRef, useState } from "react";

type UseAsyncFlagReturn = {
    isRunning: boolean;
    runWithFlag: <T>(task: () => Promise<T>) => Promise<T | undefined>;
    resetFlag: () => void;
};

export function useAsyncFlag(): UseAsyncFlagReturn {
    const [isRunning, setIsRunning] = useState(false);
    const isRunningRef = useRef(false);

    const resetFlag = useCallback((): void => {
        isRunningRef.current = false;
        setIsRunning(false);
    }, []);

    const runWithFlag = useCallback(
        async <T>(task: () => Promise<T>): Promise<T | undefined> => {
            if (isRunningRef.current) {
                return undefined;
            }

            isRunningRef.current = true;
            setIsRunning(true);

            try {
                return await task();
            } finally {
                isRunningRef.current = false;
                setIsRunning(false);
            }
        },
        []
    );

    return {
        isRunning,
        runWithFlag,
        resetFlag,
    };
}