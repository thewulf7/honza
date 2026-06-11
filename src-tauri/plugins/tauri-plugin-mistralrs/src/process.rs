use std::collections::HashSet;
use tauri::{Manager, Runtime, State};

use crate::state::{MistralrsState, SessionInfo};
use jan_utils::generate_random_port;

/// Returns true if a session keyed by `pid` (== port) still exists in the map.
/// The in-process axum server is considered alive as long as the session entry
/// exists; the TypeScript layer additionally hits `/health` to confirm.
pub async fn is_process_running_by_pid<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> Result<bool, String> {
    let state: State<MistralrsState> = app_handle.state();
    let map = state.server_processes.lock().await;
    Ok(map.contains_key(&pid))
}

pub async fn get_random_available_port<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<u16, String> {
    let state: State<MistralrsState> = app_handle.state();
    let map = state.server_processes.lock().await;

    let used_ports: HashSet<u16> = map
        .values()
        .filter_map(|session| {
            if session.info.port > 0 && session.info.port <= u16::MAX as i32 {
                Some(session.info.port as u16)
            } else {
                None
            }
        })
        .collect();

    drop(map);
    generate_random_port(&used_ports)
}

pub async fn find_session_by_model_id<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: &str,
) -> Result<Option<SessionInfo>, String> {
    let state: State<MistralrsState> = app_handle.state();
    let map = state.server_processes.lock().await;
    let session_info = map
        .values()
        .find(|s| s.info.model_id == model_id)
        .map(|s| s.info.clone());
    Ok(session_info)
}

pub async fn get_all_loaded_model_ids<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    let state: State<MistralrsState> = app_handle.state();
    let map = state.server_processes.lock().await;
    Ok(map.values().map(|s| s.info.model_id.clone()).collect())
}

pub async fn get_all_active_sessions<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<SessionInfo>, String> {
    let state: State<MistralrsState> = app_handle.state();
    let map = state.server_processes.lock().await;
    Ok(map.values().map(|s| s.info.clone()).collect())
}
