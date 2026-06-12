pub mod commands;
pub mod proxy;
pub mod remote_provider_commands;
#[cfg(test)]
pub mod tests;

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

// MLX session types used by the proxy. MLX is macOS-only, so on other platforms
// we expose a field-compatible stub: the session map is always empty there, so
// the proxy's MLX branches are dead but still compile.
#[cfg(target_os = "macos")]
pub use tauri_plugin_mlx::state::{MlxBackendSession, SessionInfo};

#[cfg(not(target_os = "macos"))]
mod mlx_stub {
    #[derive(Debug, Clone)]
    pub struct SessionInfo {
        pub pid: i32,
        pub port: i32,
        pub model_id: String,
        pub model_path: String,
        pub is_embedding: bool,
        pub api_key: String,
    }

    pub struct MlxBackendSession {
        pub info: SessionInfo,
    }
}

#[cfg(not(target_os = "macos"))]
pub use mlx_stub::{MlxBackendSession, SessionInfo};

// mistral.rs runs everywhere, so no stub is needed.
pub use tauri_plugin_mistralrs::state::MistralrsBackendSession;

/// All per-model local backend session maps the proxy can route to, so it
/// takes a single shared handle instead of one Arc per engine.
pub struct LocalSessions {
    pub mlx: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
    pub mistralrs: Arc<Mutex<HashMap<i32, MistralrsBackendSession>>>,
}

impl LocalSessions {
    pub fn new(
        mlx: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
        mistralrs: Arc<Mutex<HashMap<i32, MistralrsBackendSession>>>,
    ) -> Arc<Self> {
        Arc::new(Self { mlx, mistralrs })
    }
}
