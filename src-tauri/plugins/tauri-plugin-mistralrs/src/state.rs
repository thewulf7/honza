use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    /// For in-process sessions this equals `port` (no OS process exists).
    pub pid: i32,
    pub port: i32,
    pub model_id: String,
    pub model_path: String,
    pub is_embedding: bool,
    pub api_key: String,
}

pub struct MistralrsBackendSession {
    /// Handle to the tokio task running the per-model axum server.
    /// Aborting it shuts the server down and releases model memory.
    pub abort_handle: AbortHandle,
    pub info: SessionInfo,
}

/// State keyed by `port as i32` (same value exposed as `SessionInfo::pid`).
pub struct MistralrsState {
    pub server_processes: Arc<Mutex<HashMap<i32, MistralrsBackendSession>>>,
}

impl Default for MistralrsState {
    fn default() -> Self {
        Self {
            server_processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl MistralrsState {
    pub fn new() -> Self {
        Self::default()
    }
}
