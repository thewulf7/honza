use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub mod cleanup;
mod commands;
mod error;
mod process;
pub mod state;

pub use cleanup::cleanup_mistralrs_processes;
pub use commands::{load_mistralrs_model_impl, MistralrsConfig};
pub use state::{MistralrsBackendSession, MistralrsState};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mistralrs")
        .invoke_handler(tauri::generate_handler![
            cleanup::cleanup_mistralrs_processes,
            commands::load_mistralrs_model,
            commands::unload_mistralrs_model,
            commands::is_mistralrs_process_running,
            commands::get_mistralrs_random_port,
            commands::find_mistralrs_session_by_model,
            commands::get_mistralrs_loaded_models,
            commands::get_mistralrs_all_sessions,
        ])
        .setup(|app, _api| {
            app.manage(state::MistralrsState::new());
            Ok(())
        })
        .build()
}
