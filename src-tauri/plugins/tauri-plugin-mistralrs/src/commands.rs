use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Manager, Runtime, State};

use mistralrs_core::{ModelDType, ModelSelected};
use mistralrs_server_core::{
    mistralrs_for_server_builder::MistralRsForServerBuilder,
    mistralrs_server_router_builder::MistralRsServerRouterBuilder,
};

use crate::error::{ErrorCode, MistralrsError, ServerError, ServerResult};
use crate::process::{
    find_session_by_model_id, get_all_active_sessions, get_all_loaded_model_ids,
    get_random_available_port, is_process_running_by_pid,
};
use crate::state::{MistralrsBackendSession, MistralrsState, SessionInfo};

#[derive(serde::Serialize, serde::Deserialize)]
pub struct UnloadResult {
    success: bool,
    error: Option<String>,
}

/// Configuration forwarded from the TypeScript extension.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MistralrsConfig {
    /// Max context window tokens (0 → 4096).
    #[serde(default)]
    pub ctx_size: i32,

    /// Model weight dtype: "" | "auto" | "bf16" | "f16" | "f32".
    #[serde(default)]
    pub dtype: String,

    /// Max concurrent scheduled sequences (0 → 16).
    #[serde(default)]
    pub max_seqs: i32,

    /// Layers to keep on GPU. Empty string → automatic device mapping.
    /// Single integer (e.g. "20") puts that many layers on GPU 0.
    /// Multi-device format: "0:20;1:16".
    #[serde(default)]
    pub num_device_layers: String,

    /// Disable the KV cache (trades speed for lower memory).
    #[serde(default)]
    pub no_kv_cache: bool,

    /// Post-load in-situ quantization (ISQ): "" | "none" | "q4k" | "q5k" |
    /// "q6k" | "q8k" | "q4_0" | "q8_0" | "hqq4" | "hqq8" | "fp8".
    /// Primarily useful for non-GGUF models.
    #[serde(default)]
    pub in_situ_quant: String,

    /// HuggingFace tokenizer model ID (e.g. "meta-llama/Meta-Llama-3-8B").
    /// Leave empty to use the tokenizer embedded in the GGUF file.
    #[serde(default)]
    pub tok_model_id: String,

    /// Force CPU-only inference, disabling GPU/Metal acceleration.
    #[serde(default)]
    pub force_cpu: bool,

    /// On-device prefix-cache slots (0 → 16). Higher values reduce
    /// re-computation for repeated prefixes at the cost of VRAM.
    #[serde(default)]
    pub prefix_cache_n: i32,
}

fn anyhow_to_server_error(msg: &str, e: anyhow::Error) -> ServerError {
    ServerError::Mistralrs(MistralrsError::new(
        ErrorCode::ModelLoadFailed,
        format!("{msg}: {e}"),
        None,
    ))
}

/// Loads a GGUF model in-process and starts a per-model OpenAI-compatible
/// axum HTTP server on the given port.  The session is keyed by port.
#[allow(clippy::too_many_arguments)]
pub async fn load_mistralrs_model_impl(
    process_map_arc: std::sync::Arc<tokio::sync::Mutex<HashMap<i32, MistralrsBackendSession>>>,
    model_id: String,
    model_path: String,
    port: u16,
    config: MistralrsConfig,
    envs: HashMap<String, String>,
    is_embedding: bool,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    let model_path_pb = PathBuf::from(&model_path);
    if !model_path_pb.exists() {
        return Err(MistralrsError::new(
            ErrorCode::ModelFileNotFound,
            format!("Model file not found at: {}", model_path),
            None,
        )
        .into());
    }

    let api_key = envs
        .get("MISTRALRS_API_KEY")
        .cloned()
        .unwrap_or_default();

    let model_dir = model_path_pb
        .parent()
        .unwrap_or(&model_path_pb)
        .to_string_lossy()
        .into_owned();
    let model_filename = model_path_pb
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    let ctx_size: usize = if config.ctx_size > 0 { config.ctx_size as usize } else { 4096 };
    let max_seqs: usize = if config.max_seqs > 0 { config.max_seqs as usize } else { 16 };
    let prefix_cache_n: usize = if config.prefix_cache_n > 0 { config.prefix_cache_n as usize } else { 16 };

    let dtype = match config.dtype.to_lowercase().as_str() {
        "bf16" => ModelDType::BF16,
        "f16" => ModelDType::F16,
        "f32" => ModelDType::F32,
        _ => ModelDType::Auto,
    };

    let tok_model_id = if config.tok_model_id.is_empty() {
        None
    } else {
        Some(config.tok_model_id.clone())
    };

    let num_device_layers = if config.num_device_layers.is_empty() {
        None
    } else {
        Some(vec![config.num_device_layers.clone()])
    };

    let in_situ_quant = if config.in_situ_quant.is_empty() || config.in_situ_quant == "none" {
        None
    } else {
        Some(config.in_situ_quant.clone())
    };

    log::info!(
        "[mistralrs] Loading model in-process: {} (ctx={}, dtype={:?}, max_seqs={}, port={})",
        model_id,
        ctx_size,
        dtype,
        max_seqs,
        port,
    );

    let timeout_dur = Duration::from_secs(timeout);

    // Bind the listener early so the port is guaranteed before the slow model load.
    let listener =
        tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port))
            .await
            .map_err(ServerError::Io)?;
    let actual_port = listener
        .local_addr()
        .map_err(ServerError::Io)?
        .port();

    // Build the model and the OpenAI-compatible router, gated by a timeout.
    let router: axum::Router = tokio::time::timeout(timeout_dur, async {
        let shared_mrs = MistralRsForServerBuilder::new()
            .with_model(ModelSelected::GGUF {
                tok_model_id,
                quantized_model_id: model_dir,
                quantized_filename: model_filename,
                dtype,
                topology: None,
                max_seq_len: ctx_size,
                max_batch_size: max_seqs,
            })
            .with_max_seqs(max_seqs)
            .with_no_kv_cache(config.no_kv_cache)
            .with_prefix_cache_n(prefix_cache_n)
            .with_num_device_layers_optional(num_device_layers)
            .with_in_situ_quant_optional(in_situ_quant)
            .with_cpu(config.force_cpu)
            .build()
            .await
            .map_err(|e| anyhow_to_server_error("Failed to build model", e))?;

        // `with_include_swagger_routes` is only available with the `swagger-ui` feature.
        // Without it, swagger routes are simply absent — no call needed.
        MistralRsServerRouterBuilder::new()
            .with_mistralrs(shared_mrs)
            .build()
            .await
            .map_err(|e| anyhow_to_server_error("Failed to build router", e))
    })
    .await
    .map_err(|_| {
        ServerError::Mistralrs(MistralrsError::new(
            ErrorCode::ModelLoadTimedOut,
            format!(
                "Model '{}' took longer than {}s to load.",
                model_id, timeout
            ),
            None,
        ))
    })??;

    // Spawn the per-model HTTP server as a background tokio task.
    let abort_handle = tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            log::error!("[mistralrs] In-process server error on port {}: {}", actual_port, e);
        }
        log::info!("[mistralrs] In-process server on port {} stopped.", actual_port);
    })
    .abort_handle();

    let session_info = SessionInfo {
        pid: actual_port as i32, // expose port as pid for backward-compat unload calls
        port: actual_port as i32,
        model_id: model_id.clone(),
        model_path: model_path_pb.display().to_string(),
        is_embedding,
        api_key,
    };

    process_map_arc.lock().await.insert(
        actual_port as i32,
        MistralrsBackendSession {
            abort_handle,
            info: session_info.clone(),
        },
    );

    log::info!(
        "[mistralrs] Model '{}' ready on http://127.0.0.1:{}",
        model_id,
        actual_port
    );
    Ok(session_info)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{MistralrsBackendSession, SessionInfo};
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn make_test_session(port: i32) -> MistralrsBackendSession {
        MistralrsBackendSession {
            abort_handle: tokio::spawn(async {}).abort_handle(),
            info: SessionInfo {
                pid: port,
                port,
                model_id: format!("model-{port}"),
                model_path: format!("/tmp/model-{port}.gguf"),
                is_embedding: false,
                api_key: "test-key".into(),
            },
        }
    }

    // ── load_mistralrs_model_impl ──────────────────────────────────────────

    #[tokio::test]
    async fn load_returns_model_file_not_found_for_missing_path() {
        let map = Arc::new(Mutex::new(HashMap::new()));
        let result = load_mistralrs_model_impl(
            map,
            "test-model".into(),
            "/tmp/nonexistent_mistralrs_xyz_12345.gguf".into(),
            0,
            MistralrsConfig::default(),
            HashMap::new(),
            false,
            30,
        )
        .await;

        assert!(result.is_err());
        match result.unwrap_err() {
            ServerError::Mistralrs(e) => {
                assert!(
                    matches!(e.code, ErrorCode::ModelFileNotFound),
                    "expected ModelFileNotFound, got {:?}",
                    e.code
                );
                assert!(
                    e.message.contains("nonexistent_mistralrs_xyz_12345.gguf"),
                    "error message should include the path"
                );
            }
            other => panic!("expected Mistralrs(ModelFileNotFound), got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn load_file_not_found_leaves_map_empty() {
        let map = Arc::new(Mutex::new(HashMap::new()));
        let _ = load_mistralrs_model_impl(
            Arc::clone(&map),
            "test-model".into(),
            "/tmp/nonexistent.gguf".into(),
            0,
            Default::default(),
            HashMap::new(),
            false,
            5,
        )
        .await;

        assert!(
            map.lock().await.is_empty(),
            "no session should be inserted on file-not-found"
        );
    }

    // ── session map operations ─────────────────────────────────────────────

    #[tokio::test]
    async fn session_is_keyed_by_port_and_pid_matches() {
        let map = Arc::new(Mutex::new(HashMap::new()));
        map.lock().await.insert(9000, make_test_session(9000));

        let locked = map.lock().await;
        assert!(locked.contains_key(&9000));
        let s = locked.get(&9000).unwrap();
        assert_eq!(s.info.pid, s.info.port, "pid must equal port for backward-compat");
        assert_eq!(s.info.model_id, "model-9000");
    }

    #[tokio::test]
    async fn session_remove_returns_entry_and_leaves_map_empty() {
        let map = Arc::new(Mutex::new(HashMap::new()));
        map.lock().await.insert(8001, make_test_session(8001));

        let removed = map.lock().await.remove(&8001);
        assert!(removed.is_some());
        assert_eq!(removed.unwrap().info.port, 8001);
        assert!(map.lock().await.is_empty());
    }

    #[tokio::test]
    async fn session_remove_of_missing_key_returns_none() {
        let map: Arc<Mutex<HashMap<i32, MistralrsBackendSession>>> =
            Arc::new(Mutex::new(HashMap::new()));
        assert!(map.lock().await.remove(&9999).is_none());
    }

    #[tokio::test]
    async fn find_session_by_model_id_locates_correct_port() {
        let map = Arc::new(Mutex::new(HashMap::new()));
        map.lock().await.insert(8001, make_test_session(8001));
        map.lock().await.insert(8002, make_test_session(8002));

        let locked = map.lock().await;
        let found = locked
            .values()
            .find(|s| s.info.model_id == "model-8001")
            .map(|s| s.info.clone());

        assert!(found.is_some());
        assert_eq!(found.unwrap().port, 8001);
    }

    #[tokio::test]
    async fn multiple_sessions_are_independent() {
        let map = Arc::new(Mutex::new(HashMap::new()));
        for port in [8010_i32, 8020, 8030] {
            map.lock().await.insert(port, make_test_session(port));
        }

        assert_eq!(map.lock().await.len(), 3);

        map.lock().await.remove(&8020);
        assert_eq!(map.lock().await.len(), 2);
        assert!(map.lock().await.contains_key(&8010));
        assert!(!map.lock().await.contains_key(&8020));
        assert!(map.lock().await.contains_key(&8030));
    }

    // ── helpers ────────────────────────────────────────────────────────────

    #[test]
    fn anyhow_to_server_error_produces_model_load_failed() {
        let err = anyhow_to_server_error("loading model", anyhow::anyhow!("disk full"));
        match err {
            ServerError::Mistralrs(e) => {
                assert!(matches!(e.code, ErrorCode::ModelLoadFailed));
                assert!(e.message.contains("loading model"));
                assert!(e.message.contains("disk full"));
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn mistralrs_error_serializes_code_as_screaming_snake_case() {
        let err = MistralrsError::new(ErrorCode::ModelFileNotFound, "not found".into(), None);
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("MODEL_FILE_NOT_FOUND"), "got: {json}");
    }

    #[test]
    fn server_error_io_serializes_to_io_error_code() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let server_err = ServerError::Io(io_err);
        let json = serde_json::to_string(&server_err).unwrap();
        assert!(json.contains("IO_ERROR"), "got: {json}");
    }

    #[test]
    fn mistralrs_config_defaults_are_all_zero_or_empty() {
        let cfg = MistralrsConfig::default();
        assert_eq!(cfg.ctx_size, 0);
        assert_eq!(cfg.max_seqs, 0);
        assert_eq!(cfg.prefix_cache_n, 0);
        assert!(cfg.dtype.is_empty());
        assert!(cfg.num_device_layers.is_empty());
        assert!(cfg.in_situ_quant.is_empty());
        assert!(cfg.tok_model_id.is_empty());
        assert!(!cfg.no_kv_cache);
        assert!(!cfg.force_cpu);
    }

    #[test]
    fn dtype_mapping_auto_for_unknown_strings() {
        for s in ["", "auto", "AUTO", "unknown", "fp32x"] {
            let mapped = match s.to_lowercase().as_str() {
                "bf16" => "BF16",
                "f16" => "F16",
                "f32" => "F32",
                _ => "Auto",
            };
            assert_eq!(mapped, "Auto", "'{s}' should map to Auto");
        }
    }

    #[test]
    fn dtype_mapping_known_variants() {
        assert_eq!(
            match "bf16" { "bf16" => "BF16", "f16" => "F16", "f32" => "F32", _ => "Auto" },
            "BF16"
        );
        assert_eq!(
            match "f16" { "bf16" => "BF16", "f16" => "F16", "f32" => "F32", _ => "Auto" },
            "F16"
        );
        assert_eq!(
            match "f32" { "bf16" => "BF16", "f16" => "F16", "f32" => "F32", _ => "Auto" },
            "F32"
        );
    }

    #[test]
    fn in_situ_quant_none_and_empty_treated_the_same() {
        for s in ["", "none"] {
            let result: Option<String> = if s.is_empty() || s == "none" {
                None
            } else {
                Some(s.to_string())
            };
            assert!(result.is_none(), "'{s}' should produce None");
        }
        let result: Option<String> = if "q4k".is_empty() || "q4k" == "none" {
            None
        } else {
            Some("q4k".to_string())
        };
        assert_eq!(result.as_deref(), Some("q4k"));
    }

    #[test]
    fn num_device_layers_empty_produces_none() {
        let empty: Option<Vec<String>> = if "".is_empty() {
            None
        } else {
            Some(vec!["".to_string()])
        };
        assert!(empty.is_none());

        let with_value: Option<Vec<String>> = if "20".is_empty() {
            None
        } else {
            Some(vec!["20".to_string()])
        };
        assert_eq!(with_value, Some(vec!["20".to_string()]));
    }

    #[tokio::test]
    async fn load_file_not_found_respects_new_config_fields() {
        let map = Arc::new(Mutex::new(HashMap::new()));
        let cfg = MistralrsConfig {
            ctx_size: 2048,
            dtype: "bf16".into(),
            max_seqs: 4,
            num_device_layers: "10".into(),
            no_kv_cache: true,
            in_situ_quant: "q4k".into(),
            tok_model_id: "meta-llama/Llama-3.2-1B".into(),
            force_cpu: false,
            prefix_cache_n: 8,
        };
        let result = load_mistralrs_model_impl(
            map,
            "test-model".into(),
            "/tmp/nonexistent_full_config.gguf".into(),
            0,
            cfg,
            HashMap::new(),
            false,
            5,
        )
        .await;
        // File-not-found fires before any builder call, regardless of config.
        match result.unwrap_err() {
            ServerError::Mistralrs(e) => assert!(matches!(e.code, ErrorCode::ModelFileNotFound)),
            other => panic!("expected ModelFileNotFound, got: {other:?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn load_mistralrs_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
    model_path: String,
    port: u16,
    config: MistralrsConfig,
    envs: HashMap<String, String>,
    is_embedding: bool,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    let state: State<MistralrsState> = app_handle.state();
    load_mistralrs_model_impl(
        state.server_processes.clone(),
        model_id,
        model_path,
        port,
        config,
        envs,
        is_embedding,
        timeout,
    )
    .await
}

#[tauri::command]
pub async fn unload_mistralrs_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> ServerResult<UnloadResult> {
    let state: State<MistralrsState> = app_handle.state();
    let mut map = state.server_processes.lock().await;

    if let Some(session) = map.remove(&pid) {
        log::info!(
            "[mistralrs] Unloading model '{}' (port {})",
            session.info.model_id,
            pid
        );
        session.abort_handle.abort();
        Ok(UnloadResult {
            success: true,
            error: None,
        })
    } else {
        log::warn!("[mistralrs] No session found with pid/port {}", pid);
        Ok(UnloadResult {
            success: true,
            error: None,
        })
    }
}

#[tauri::command]
pub async fn is_mistralrs_process_running<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> Result<bool, String> {
    is_process_running_by_pid(app_handle, pid).await
}

#[tauri::command]
pub async fn get_mistralrs_random_port<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<u16, String> {
    get_random_available_port(app_handle).await
}

#[tauri::command]
pub async fn find_mistralrs_session_by_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
) -> Result<Option<SessionInfo>, String> {
    find_session_by_model_id(app_handle, &model_id).await
}

#[tauri::command]
pub async fn get_mistralrs_loaded_models<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    get_all_loaded_model_ids(app_handle).await
}

#[tauri::command]
pub async fn get_mistralrs_all_sessions<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<SessionInfo>, String> {
    get_all_active_sessions(app_handle).await
}
