use tauri::{Manager, Runtime};

use crate::process::terminate_process;

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
    for (pid, session) in map.drain() {
        log::info!(
            "[mistralrs] Stopping server for model '{}' (PID {})",
            session.info.model_id,
            pid
        );
        let mut child = session.child;
        terminate_process(&mut child).await;
    }
    if count > 0 {
        log::info!("[mistralrs] Stopped {} server process(es)", count);
    }
}

#[tauri::command]
pub async fn cleanup_mistralrs_processes<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<(), String> {
    cleanup_processes(&app_handle).await;
    Ok(())
}
