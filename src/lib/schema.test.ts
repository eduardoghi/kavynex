import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { ensureSchema } from "./schema";
import { CHANNELS_TABLE_DDL } from "./schema-ddl";

type QueryResult = { lastInsertId: number; rowsAffected: number };

function createDb(sqlite: BetterSqlite3.Database, executedStatements: string[] = []) {
    return {
        select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
            const stmt = sqlite.prepare(query);
            return Promise.resolve(stmt.all(...(bindValues as any[])) as T);
        },

        execute(query: string, bindValues: unknown[] = []): Promise<QueryResult> {
            executedStatements.push(query.trim());
            const stmt = sqlite.prepare(query);
            const result = stmt.run(...(bindValues as any[]));
            return Promise.resolve({
                lastInsertId: Number(result.lastInsertRowid),
                rowsAffected: result.changes,
            });
        },
    };
}

describe("ensureSchema", () => {
    it("adds a unique channel/file-path index to legacy videos tables", async () => {
        const sqlite = new BetterSqlite3(":memory:");
        sqlite.pragma("foreign_keys = ON");

        sqlite.exec(`
            ${CHANNELS_TABLE_DDL};

            CREATE TABLE videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id INTEGER NOT NULL,
                title TEXT NOT NULL CHECK (TRIM(title) <> ''),
                file_path TEXT NOT NULL CHECK (TRIM(file_path) <> ''),
                thumbnail_path TEXT CHECK (thumbnail_path IS NULL OR TRIM(thumbnail_path) <> ''),
                media_type TEXT NOT NULL CHECK (media_type IN ('video', 'audio')),
                youtube_video_id TEXT,
                watched_at TEXT,
                published_at TEXT,
                duration_seconds INTEGER,
                progress_seconds INTEGER NOT NULL DEFAULT 0,
                has_comments INTEGER NOT NULL DEFAULT 0,
                comments_count INTEGER NOT NULL DEFAULT 0,
                is_live INTEGER NOT NULL DEFAULT 0,
                has_live_chat INTEGER NOT NULL DEFAULT 0,
                live_chat_file_path TEXT CHECK (live_chat_file_path IS NULL OR TRIM(live_chat_file_path) <> ''),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
            );
        `);

        const executedStatements: string[] = [];
        const db = createDb(sqlite, executedStatements);

        await ensureSchema(db as any);

        expect(executedStatements).toContain("PRAGMA busy_timeout = 5000;");
        expect(executedStatements).toContain("PRAGMA journal_mode = WAL;");
        expect(sqlite.pragma("busy_timeout")).toEqual([{ timeout: 5000 }]);

        const indexes = sqlite.prepare("PRAGMA index_list(videos)").all() as { name: string }[];
        expect(indexes.some((index) => index.name === "idx_videos_channel_file_path_unique")).toBe(true);

        sqlite
            .prepare("INSERT INTO channels (name, youtube_handle) VALUES (?, ?)")
            .run("Test Channel", "@test");
        sqlite
            .prepare(
                `INSERT INTO videos (channel_id, title, file_path, media_type)
                 VALUES (?, ?, ?, ?)`
            )
            .run(1, "First", "video/a.mp4", "video");

        expect(() =>
            sqlite
                .prepare(
                    `INSERT INTO videos (channel_id, title, file_path, media_type)
                     VALUES (?, ?, ?, ?)`
                )
                .run(1, "Duplicate", "video/a.mp4", "video")
        ).toThrow();

        sqlite.close();
    });
});
