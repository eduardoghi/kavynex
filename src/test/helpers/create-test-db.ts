import BetterSqlite3 from "better-sqlite3";
import {
    APP_SETTINGS_TABLE_DDL,
    CHANNELS_TABLE_DDL,
    SCHEMA_INDEXES_DDL,
    VIDEO_COMMENTS_TABLE_DDL,
    VIDEO_LIVE_CHAT_MESSAGES_TABLE_DDL,
    VIDEOS_TABLE_DDL,
} from "../../lib/schema-ddl";

type QueryResult = { lastInsertId: number; rowsAffected: number };

export type TestDatabase = {
    select<T>(query: string, bindValues?: unknown[]): Promise<T>;
    execute(query: string, bindValues?: unknown[]): Promise<QueryResult>;
};

const SCHEMA_SQL = [
    CHANNELS_TABLE_DDL,
    VIDEOS_TABLE_DDL,
    VIDEO_COMMENTS_TABLE_DDL,
    VIDEO_LIVE_CHAT_MESSAGES_TABLE_DDL,
    APP_SETTINGS_TABLE_DDL,
    ...SCHEMA_INDEXES_DDL,
].join(";\n");

export function createTestDb(): { db: TestDatabase; close: () => void } {
    const sqlite = new BetterSqlite3(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(SCHEMA_SQL);

    const db: TestDatabase = {
        select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
            const stmt = sqlite.prepare(query);
            return Promise.resolve(stmt.all(...(bindValues as any[])) as T);
        },

        execute(query: string, bindValues: unknown[] = []): Promise<QueryResult> {
            const stmt = sqlite.prepare(query);
            const result = stmt.run(...(bindValues as any[]));
            return Promise.resolve({
                lastInsertId: Number(result.lastInsertRowid),
                rowsAffected: result.changes,
            });
        },
    };

    return { db, close: () => sqlite.close() };
}
