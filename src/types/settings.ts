export type ImportMode = "copy" | "move";

export type AppSettings = {
    importMode: ImportMode;
    libraryPath: string;
};