use tauri::AppHandle;

use crate::services::database::shared_pool;
use crate::AppResult;

/// Initializes the shared database pool (creating and migrating the schema on first
/// call) and confirms the database is reachable. Called by the frontend on startup so
/// database initialization errors surface to the user before any feature runs.
#[tauri::command]
pub async fn ensure_database_ready(app: AppHandle) -> AppResult<()> {
    shared_pool(&app).await?;
    Ok(())
}
