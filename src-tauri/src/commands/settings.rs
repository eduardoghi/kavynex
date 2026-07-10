use tauri::AppHandle;

use crate::services::database::{
    get_app_settings_from_pool, set_app_settings_in_pool, shared_pool, StoredAppSettings,
};
use crate::AppResult;

#[tauri::command]
pub async fn get_app_settings(app: AppHandle) -> AppResult<StoredAppSettings> {
    let pool = shared_pool(&app).await?;
    get_app_settings_from_pool(pool).await
}

#[tauri::command]
pub async fn set_app_settings(
    app: AppHandle,
    import_mode: String,
    library_path: String,
    load_remote_images: bool,
) -> AppResult<()> {
    let pool = shared_pool(&app).await?;
    set_app_settings_in_pool(
        pool,
        import_mode.trim(),
        library_path.trim(),
        load_remote_images,
    )
    .await
}
