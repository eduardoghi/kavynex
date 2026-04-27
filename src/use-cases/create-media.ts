import type { ImportMode } from "../types/settings";
import type { MediaSourceMode, MediaType } from "../types/media";
import { createMedia } from "../services";

export type ExecuteCreateMediaInput = {
    channelId: number;
    title: string;
    sourceMode: MediaSourceMode;
    sourceValue: string;
    thumbnailSourcePath: string | null;
    mediaType: MediaType;
    importMode: ImportMode;
    libraryPath: string;
    publishedAt: string | null;
    ytDlpRunId: string;
    ytDlpFormatId: string;
    downloadComments: boolean;
    downloadLiveChat: boolean;
    cookiesBrowser: string | null;
};

type ExecuteCreateMediaOptions = {
    input: ExecuteCreateMediaInput;
    reloadMedia: (channelId?: number | null) => Promise<void>;
};

export async function executeCreateMedia({
    input,
    reloadMedia,
}: ExecuteCreateMediaOptions): Promise<void> {
    await createMedia(input);
    await reloadMedia(input.channelId);
}