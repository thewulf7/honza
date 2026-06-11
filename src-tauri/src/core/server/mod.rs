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
pub use tauri_plugin_mlx::state::{MlxBackendSession, SessionInfo as MlxSessionInfo};

#[cfg(not(target_os = "macos"))]
mod mlx_stub {
    #[derive(Debug, Clone)]
    pub struct MlxSessionInfo {
        pub pid: i32,
        pub port: i32,
        pub model_id: String,
        pub model_path: String,
        pub is_embedding: bool,
        pub api_key: String,
    }

    pub struct MlxBackendSession {
        pub info: MlxSessionInfo,
    }
}

#[cfg(not(target_os = "macos"))]
pub use mlx_stub::{MlxBackendSession, MlxSessionInfo};

// mistral.rs is cross-platform.
pub use tauri_plugin_mistralrs::state::MistralrsBackendSession;

/// Bundles all local backend session maps in one place so the proxy only needs
/// one parameter instead of a separate Arc<Mutex<...>> per backend.
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
