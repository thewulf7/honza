use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub pid: i32,
    pub port: i32,
    pub model_id: String,
    pub model_path: String,
    pub is_embedding: bool,
    pub api_key: String,
}

pub struct MlxBackendSession {
    pub child: Child,
    pub info: SessionInfo,
}

/// MLX plugin state
pub struct MlxState {
    pub mlx_server_process: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
    /// Optional override for the mlx-server binary path.
    /// When `Some`, this path takes priority over the bundled resource binary.
    pub custom_binary_path: Arc<Mutex<Option<PathBuf>>>,
}

impl Default for MlxState {
    fn default() -> Self {
        Self {
            mlx_server_process: Arc::new(Mutex::new(HashMap::new())),
            custom_binary_path: Arc::new(Mutex::new(None)),
        }
    }
}

impl MlxState {
    pub fn new() -> Self {
        Self::default()
    }
}
