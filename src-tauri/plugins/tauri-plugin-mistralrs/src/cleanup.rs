use tauri::{Manager, Runtime};

pub async fn cleanup_processes<R: Runtime>(app_handle: &tauri::AppHandle<R>) {
    let app_state = match app_handle.try_state::<crate::state::MistralrsState>() {
        Some(state) => state,
        None => {
            log::warn!("MistralrsState not found during cleanup");
            return;
        }
    };

    let mut map = app_state.server_processes.lock().await;
    let count = map.len();
    for (port, session) in map.drain() {
        log::info!(
            "[mistralrs] Stopping in-process server for model '{}' on port {}",
            session.info.model_id,
            port
        );
        session.abort_handle.abort();
    }
    if count > 0 {
        log::info!("[mistralrs] Stopped {} in-process server(s)", count);
    }
}

#[tauri::command]
pub async fn cleanup_mistralrs_processes<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<(), String> {
    cleanup_processes(&app_handle).await;
    Ok(())
}
