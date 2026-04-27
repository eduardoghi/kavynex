import Database from "@tauri-apps/plugin-sql";
import { ensureSchema } from "./schema";

let dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
    if (!dbPromise) {
        dbPromise = (async () => {
            const db = await Database.load("sqlite:kavynex.db");
            await ensureSchema(db);
            return db;
        })().catch((error) => {
            dbPromise = null;
            throw error;
        });
    }

    return dbPromise;
}