use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    /// mistralrs-server has no request authentication; kept for parity with
    /// other local backends so the proxy can treat sessions uniformly.
    pub api_key: String,
}

pub struct MistralrsBackendSession {
    pub child: Child,
    pub info: SessionInfo,
}

/// State keyed by the server process PID.
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
