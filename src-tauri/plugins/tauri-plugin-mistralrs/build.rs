const COMMANDS: &[&str] = &[
    "cleanup_mistralrs_processes",
    "load_mistralrs_model",
    "unload_mistralrs_model",
    "is_mistralrs_process_running",
    "get_mistralrs_random_port",
    "find_mistralrs_session_by_model",
    "get_mistralrs_loaded_models",
    "get_mistralrs_all_sessions",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
