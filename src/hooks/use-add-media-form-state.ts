import { useCallback, useReducer } from "react";
import type { MediaSourceMode, MediaType } from "../types/media";

type AddMediaFormState = {
    sourceMode: MediaSourceMode;
    mediaUrl: string;
    title: string;
    mediaPath: string;
    mediaType: MediaType;
    publishedAt: string;
    isDragging: boolean;
    isThumbDragging: boolean;
};

type AddMediaFormAction =
    | {
          type: "RESET_FORM";
      }
    | {
          type: "SET_SOURCE_MODE";
          payload: MediaSourceMode;
      }
    | {
          type: "SET_MEDIA_URL";
          payload: string;
      }
    | {
          type: "SET_TITLE";
          payload: string;
      }
    | {
          type: "SET_PUBLISHED_AT";
          payload: string;
      }
    | {
          type: "SET_MEDIA_TYPE";
          payload: MediaType;
      }
    | {
          type: "SET_MEDIA_DRAGGING";
          payload: boolean;
      }
    | {
          type: "SET_THUMB_DRAGGING";
          payload: boolean;
      }
    | {
          type: "APPLY_LOCAL_MEDIA_SELECTION";
          payload: {
              mediaPath: string;
              mediaType: MediaType;
              nextTitle: string | null;
          };
      };

function createInitialState(): AddMediaFormState {
    return {
        sourceMode: "local",
        mediaUrl: "",
        title: "",
        mediaPath: "",
        mediaType: "video",
        publishedAt: "",
        isDragging: false,
        isThumbDragging: false,
    };
}

function addMediaFormStateReducer(
    state: AddMediaFormState,
    action: AddMediaFormAction
): AddMediaFormState {
    switch (action.type) {
        case "RESET_FORM":
            return createInitialState();

        case "SET_SOURCE_MODE":
            return {
                ...createInitialState(),
                sourceMode: action.payload,
            };

        case "SET_MEDIA_URL":
            return {
                ...state,
                mediaUrl: action.payload,
            };

        case "SET_TITLE":
            return {
                ...state,
                title: action.payload,
            };

        case "SET_PUBLISHED_AT":
            return {
                ...state,
                publishedAt: action.payload,
            };

        case "SET_MEDIA_TYPE":
            return {
                ...state,
                mediaType: action.payload,
            };

        case "SET_MEDIA_DRAGGING":
            return {
                ...state,
                isDragging: action.payload,
            };

        case "SET_THUMB_DRAGGING":
            return {
                ...state,
                isThumbDragging: action.payload,
            };

        case "APPLY_LOCAL_MEDIA_SELECTION":
            return {
                ...state,
                mediaUrl: "",
                mediaPath: action.payload.mediaPath,
                mediaType: action.payload.mediaType,
                isDragging: false,
                title: action.payload.nextTitle ?? state.title,
            };

        default:
            return state;
    }
}

type UseAddMediaFormStateReturn = {
    state: AddMediaFormState;
    setSourceModeState: (value: MediaSourceMode) => void;
    setMediaUrlState: (value: string) => void;
    setTitleState: (value: string) => void;
    setPublishedAtState: (value: string) => void;
    setMediaTypeState: (value: MediaType) => void;
    setIsDraggingState: (value: boolean) => void;
    setIsThumbDraggingState: (value: boolean) => void;
    applyLocalMediaSelectionState: (
        mediaPath: string,
        mediaType: MediaType,
        nextTitle: string | null
    ) => void;
    resetFormState: () => void;
};

export function useAddMediaFormState(): UseAddMediaFormStateReturn {
    const [state, dispatch] = useReducer(addMediaFormStateReducer, undefined, createInitialState);

    const setSourceModeState = useCallback((value: MediaSourceMode): void => {
        dispatch({
            type: "SET_SOURCE_MODE",
            payload: value,
        });
    }, []);

    const setMediaUrlState = useCallback((value: string): void => {
        dispatch({
            type: "SET_MEDIA_URL",
            payload: value,
        });
    }, []);

    const setTitleState = useCallback((value: string): void => {
        dispatch({
            type: "SET_TITLE",
            payload: value,
        });
    }, []);

    const setPublishedAtState = useCallback((value: string): void => {
        dispatch({
            type: "SET_PUBLISHED_AT",
            payload: value,
        });
    }, []);

    const setMediaTypeState = useCallback((value: MediaType): void => {
        dispatch({
            type: "SET_MEDIA_TYPE",
            payload: value,
        });
    }, []);

    const setIsDraggingState = useCallback((value: boolean): void => {
        dispatch({
            type: "SET_MEDIA_DRAGGING",
            payload: value,
        });
    }, []);

    const setIsThumbDraggingState = useCallback((value: boolean): void => {
        dispatch({
            type: "SET_THUMB_DRAGGING",
            payload: value,
        });
    }, []);

    const applyLocalMediaSelectionState = useCallback(
        (mediaPath: string, mediaType: MediaType, nextTitle: string | null): void => {
            dispatch({
                type: "APPLY_LOCAL_MEDIA_SELECTION",
                payload: {
                    mediaPath,
                    mediaType,
                    nextTitle,
                },
            });
        },
        []
    );

    const resetFormState = useCallback((): void => {
        dispatch({
            type: "RESET_FORM",
        });
    }, []);

    return {
        state,
        setSourceModeState,
        setMediaUrlState,
        setTitleState,
        setPublishedAtState,
        setMediaTypeState,
        setIsDraggingState,
        setIsThumbDraggingState,
        applyLocalMediaSelectionState,
        resetFormState,
    };
}