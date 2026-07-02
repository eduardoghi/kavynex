import { getDb } from "./db";

// Transitional bridge used during the migration to a Rust-owned database. The schema is
// still created by the frontend sql plugin, so touching getDb() guarantees the tables
// exist before the backend database commands query them. Removed at the final cutover
// once schema creation moves to Rust.
export async function ensureSchemaReady(): Promise<void> {
    await getDb();
}
