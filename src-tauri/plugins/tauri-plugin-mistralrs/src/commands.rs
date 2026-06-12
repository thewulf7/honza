use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::error::{ErrorCode, MistralrsError, ServerError, ServerResult};
use crate::process::{
    find_session_by_model_id, get_all_active_sessions, get_all_loaded_model_ids,
    get_random_available_port, is_process_running_by_pid, terminate_process,
};
use crate::state::{MistralrsBackendSession, MistralrsState, SessionInfo};

use jan_utils::{find_cuda_paths, setup_library_path, setup_windows_process_flags};

#[derive(serde::Serialize, serde::Deserialize)]
pub struct UnloadResult {
    success: bool,
    error: Option<String>,
}

/// Configuration forwarded from the TypeScript extension. Every field maps to
/// a `mistralrs-server` CLI flag; zero / empty values mean "use server default"
/// and the flag is omitted.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MistralrsConfig {
    /// Max prompt sequence length in tokens (`--max-seq-len` on the gguf
    /// subcommand). 0 → server default.
    #[serde(default)]
    pub ctx_size: i32,

    /// Model weight dtype: "" | "auto" | "bf16" | "f16" | "f32" (`--dtype`).
    #[serde(default)]
    pub dtype: String,

    /// Max concurrent scheduled sequences (`--max-seqs`). 0 → server default.
    #[serde(default)]
    pub max_seqs: i32,

    /// Max prompt batch size (`--max-batch-size` on the gguf subcommand).
    /// 0 → server default.
    #[serde(default)]
    pub max_batch_size: i32,

    /// Layers to keep on GPU (`--num-device-layers`). Empty → automatic
    /// device mapping. Single integer (e.g. "20") puts that many layers on
    /// GPU 0. Multi-device format: "0:20;1:16".
    #[serde(default)]
    pub num_device_layers: String,

    /// Disable the KV cache (`--no-kv-cache`).
    #[serde(default)]
    pub no_kv_cache: bool,

    /// Post-load in-situ quantization (`--isq`): "" | "none" | "q4k" | ...
    #[serde(default)]
    pub in_situ_quant: String,

    /// HuggingFace tokenizer model ID (`--tok-model-id` on the gguf
    /// subcommand). Empty → tokenizer embedded in the GGUF file.
    #[serde(default)]
    pub tok_model_id: String,

    /// Force CPU-only inference (`--cpu`).
    #[serde(default)]
    pub force_cpu: bool,

    /// On-device prefix-cache slots (`--prefix-cache-n`). 0 → server default.
    #[serde(default)]
    pub prefix_cache_n: i32,

    /// RNG seed for reproducible generation (`--seed`). Negative → unset.
    #[serde(default = "default_seed")]
    pub seed: i64,

    /// Enable PagedAttention on Metal (`--paged-attn`).
    #[serde(default)]
    pub paged_attn: bool,

    /// Disable PagedAttention on CUDA (`--no-paged-attn`).
    #[serde(default)]
    pub no_paged_attn: bool,

    /// GPU memory reserved for the PagedAttention KV cache in MB
    /// (`--pa-gpu-mem`). 0 → unset.
    #[serde(default)]
    pub paged_attn_gpu_mem: i32,

    /// Fraction (0-1] of GPU memory to use for the PagedAttention KV cache
    /// (`--pa-gpu-mem-usage`). 0 → unset.
    #[serde(default)]
    pub paged_attn_gpu_mem_usage: f32,

    /// Total context length the PagedAttention KV cache is sized for
    /// (`--pa-ctxt-len`). 0 → unset.
    #[serde(default)]
    pub paged_ctxt_len: i32,

    /// PagedAttention block size (`--pa-blk-size`). 0 → unset.
    #[serde(default)]
    pub paged_attn_block_size: i32,

    /// PagedAttention KV cache type (`--pa-cache-type`): "" | "auto" | "f8e4m3".
    #[serde(default)]
    pub paged_cache_type: String,

    /// Path to a JINJA chat template file (`--chat-template`).
    #[serde(default)]
    pub chat_template: String,

    /// Path to an explicit JINJA chat template file taking precedence over
    /// everything else (`--jinja-explicit`).
    #[serde(default)]
    pub jinja_explicit: String,

    /// HuggingFace token source (`--token-source`): "cache" | "env:<VAR>" |
    /// "path:<file>" | "literal:<token>" | "none". Empty → server default.
    #[serde(default)]
    pub token_source: String,
}

fn default_seed() -> i64 {
    -1
}

fn opt_flag(args: &mut Vec<String>, cond: bool, flag: &str) {
    if cond {
        args.push(flag.to_string());
    }
}

fn opt_value(args: &mut Vec<String>, value: &str, flag: &str) {
    if !value.is_empty() {
        args.push(flag.to_string());
        args.push(value.to_string());
    }
}

/// Builds the full mistralrs-server argument list:
/// `[global flags...] gguf -m <dir> -f <file> [gguf flags...]`
fn build_server_args(
    config: &MistralrsConfig,
    port: u16,
    model_dir: &str,
    model_filename: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--serve-ip".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
    ];

    if config.seed >= 0 {
        args.push("--seed".into());
        args.push(config.seed.to_string());
    }
    if config.max_seqs > 0 {
        args.push("--max-seqs".into());
        args.push(config.max_seqs.to_string());
    }
    opt_flag(&mut args, config.no_kv_cache, "--no-kv-cache");
    if config.prefix_cache_n > 0 {
        args.push("--prefix-cache-n".into());
        args.push(config.prefix_cache_n.to_string());
    }
    opt_value(&mut args, &config.num_device_layers, "--num-device-layers");
    if !config.in_situ_quant.is_empty() && config.in_situ_quant != "none" {
        args.push("--isq".into());
        args.push(config.in_situ_quant.clone());
    }
    opt_flag(&mut args, config.force_cpu, "--cpu");
    opt_flag(&mut args, config.paged_attn, "--paged-attn");
    opt_flag(&mut args, config.no_paged_attn, "--no-paged-attn");
    if config.paged_attn_gpu_mem > 0 {
        args.push("--pa-gpu-mem".into());
        args.push(config.paged_attn_gpu_mem.to_string());
    }
    if config.paged_attn_gpu_mem_usage > 0.0 {
        args.push("--pa-gpu-mem-usage".into());
        args.push(format!("{}", config.paged_attn_gpu_mem_usage));
    }
    if config.paged_ctxt_len > 0 {
        args.push("--pa-ctxt-len".into());
        args.push(config.paged_ctxt_len.to_string());
    }
    if config.paged_attn_block_size > 0 {
        args.push("--pa-blk-size".into());
        args.push(config.paged_attn_block_size.to_string());
    }
    if !config.paged_cache_type.is_empty() && config.paged_cache_type != "auto" {
        args.push("--pa-cache-type".into());
        args.push(config.paged_cache_type.clone());
    }
    opt_value(&mut args, &config.chat_template, "--chat-template");
    opt_value(&mut args, &config.jinja_explicit, "--jinja-explicit");
    opt_value(&mut args, &config.token_source, "--token-source");

    // gguf subcommand
    args.push("gguf".into());
    args.push("-m".into());
    args.push(model_dir.to_string());
    args.push("-f".into());
    args.push(model_filename.to_string());

    opt_value(&mut args, &config.tok_model_id, "--tok-model-id");
    if !config.dtype.is_empty() && config.dtype != "auto" {
        args.push("--dtype".into());
        args.push(config.dtype.clone());
    }
    if config.ctx_size > 0 {
        args.push("--max-seq-len".into());
        args.push(config.ctx_size.to_string());
    }
    if config.max_batch_size > 0 {
        args.push("--max-batch-size".into());
        args.push(config.max_batch_size.to_string());
    }

    args
}

/// Spawns a mistralrs-server process for one GGUF model and waits until its
/// HTTP `/health` endpoint responds (or the process dies / times out).
#[allow(clippy::too_many_arguments)]
pub async fn load_mistralrs_model_impl(
    process_map_arc: Arc<Mutex<HashMap<i32, MistralrsBackendSession>>>,
    backend_path: &str,
    model_id: String,
    model_path: String,
    port: u16,
    config: MistralrsConfig,
    envs: HashMap<String, String>,
    is_embedding: bool,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    let bin_path = PathBuf::from(backend_path);
    if !bin_path.exists() {
        return Err(MistralrsError::new(
            ErrorCode::BinaryNotFound,
            format!("mistralrs-server binary not found at: {}", backend_path),
            Some("Download a backend in Settings → mistral.rs first.".into()),
        )
        .into());
    }

    let model_path_pb = PathBuf::from(&model_path);
    if !model_path_pb.exists() {
        return Err(MistralrsError::new(
            ErrorCode::ModelFileNotFound,
            format!("Model file not found at: {}", model_path),
            None,
        )
        .into());
    }

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

    let args = build_server_args(&config, port, &model_dir, &model_filename);
    log::info!(
        "[mistralrs] Launching {} with args: {:?}",
        bin_path.display(),
        args
    );

    let mut command = Command::new(&bin_path);
    command.args(&args);
    command.envs(&envs);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);
    setup_windows_process_flags(&mut command);

    // Make bundled (next to the exe) and system CUDA libraries resolvable.
    let cuda = find_cuda_paths();
    setup_library_path(bin_path.parent(), &cuda, &mut command);
    #[cfg(target_os = "windows")]
    {
        if let Some(bin_dir) = bin_path.parent() {
            let mut path_entries = vec![bin_dir.to_string_lossy().into_owned()];
            path_entries.extend(cuda.bin_paths.iter().cloned());
            if let Ok(current) = std::env::var("PATH") {
                path_entries.push(current);
            }
            command.env("PATH", path_entries.join(";"));
        }
    }

    let mut child = command.spawn().map_err(ServerError::Io)?;

    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if !line.is_empty() {
                log::info!("[mistralrs stdout] {}", line);
            }
        }
    });

    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut buffer = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if !line.is_empty() {
                log::info!("[mistralrs] {}", line);
                buffer.push_str(&line);
                buffer.push('\n');
            }
        }
        buffer
    });

    // Readiness: poll /health until 200, watching for early process exit.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let health_url = format!("http://127.0.0.1:{}/health", port);
    let timeout_duration = Duration::from_secs(timeout);
    let start_time = Instant::now();

    loop {
        if let Some(status) = child.try_wait()? {
            let stderr_output = stderr_task.await.unwrap_or_default();
            log::error!(
                "[mistralrs] Server exited early with {:?}\n{}",
                status,
                stderr_output
            );
            let code = if stderr_output.to_lowercase().contains("out of memory")
                || stderr_output.contains("CUDA_ERROR_OUT_OF_MEMORY")
            {
                ErrorCode::OutOfMemory
            } else {
                ErrorCode::ModelLoadFailed
            };
            return Err(MistralrsError::new(
                code,
                "mistralrs-server exited before becoming ready.".into(),
                Some(stderr_output),
            )
            .into());
        }

        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                log::info!("[mistralrs] Server on port {} is ready", port);
                break;
            }
        }

        if start_time.elapsed() > timeout_duration {
            let _ = child.kill().await;
            let stderr_output = stderr_task.await.unwrap_or_default();
            return Err(MistralrsError::new(
                ErrorCode::ModelLoadTimedOut,
                "The mistral.rs model took too long to load and timed out.".into(),
                Some(format!(
                    "Timeout: {}s\n\nStderr:\n{}",
                    timeout_duration.as_secs(),
                    stderr_output
                )),
            )
            .into());
        }

        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    let pid = child.id().map(|id| id as i32).unwrap_or(-1);
    log::info!("[mistralrs] Server started with PID {} on port {}", pid, port);

    let session_info = SessionInfo {
        pid,
        port: port.into(),
        model_id,
        model_path: model_path_pb.display().to_string(),
        is_embedding,
        // mistralrs-server has no request authentication; sessions are
        // loopback-only.
        api_key: String::new(),
    };

    let mut process_map = process_map_arc.lock().await;
    process_map.insert(
        pid,
        MistralrsBackendSession {
            child,
            info: session_info.clone(),
        },
    );

    Ok(session_info)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn load_mistralrs_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    backend_path: String,
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
        &backend_path,
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
        let mut child = session.child;
        terminate_process(&mut child).await;
        Ok(UnloadResult {
            success: true,
            error: None,
        })
    } else {
        log::warn!("No mistralrs-server with PID '{}' found", pid);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_produces_minimal_args() {
        let config = MistralrsConfig {
            seed: -1,
            ..Default::default()
        };
        let args = build_server_args(&config, 8080, "/models/foo", "foo.gguf");
        assert_eq!(
            args,
            vec![
                "--serve-ip",
                "127.0.0.1",
                "--port",
                "8080",
                "gguf",
                "-m",
                "/models/foo",
                "-f",
                "foo.gguf",
            ]
        );
    }

    #[test]
    fn full_config_maps_all_flags() {
        let config = MistralrsConfig {
            ctx_size: 8192,
            dtype: "bf16".into(),
            max_seqs: 8,
            max_batch_size: 4,
            num_device_layers: "0:20;1:16".into(),
            no_kv_cache: true,
            in_situ_quant: "q4k".into(),
            tok_model_id: "meta-llama/Meta-Llama-3-8B".into(),
            force_cpu: true,
            prefix_cache_n: 32,
            seed: 42,
            paged_attn: true,
            no_paged_attn: false,
            paged_attn_gpu_mem: 4096,
            paged_attn_gpu_mem_usage: 0.9,
            paged_ctxt_len: 16384,
            paged_attn_block_size: 32,
            paged_cache_type: "f8e4m3".into(),
            chat_template: "/tpl.jinja".into(),
            jinja_explicit: "/explicit.jinja".into(),
            token_source: "none".into(),
        };
        let args = build_server_args(&config, 9999, "/m", "x.gguf");
        let joined = args.join(" ");
        assert!(joined.contains("--seed 42"));
        assert!(joined.contains("--max-seqs 8"));
        assert!(joined.contains("--no-kv-cache"));
        assert!(joined.contains("--prefix-cache-n 32"));
        assert!(joined.contains("--num-device-layers 0:20;1:16"));
        assert!(joined.contains("--isq q4k"));
        assert!(joined.contains("--cpu"));
        assert!(joined.contains("--paged-attn"));
        assert!(joined.contains("--pa-gpu-mem 4096"));
        assert!(joined.contains("--pa-gpu-mem-usage 0.9"));
        assert!(joined.contains("--pa-ctxt-len 16384"));
        assert!(joined.contains("--pa-blk-size 32"));
        assert!(joined.contains("--pa-cache-type f8e4m3"));
        assert!(joined.contains("--chat-template /tpl.jinja"));
        assert!(joined.contains("--jinja-explicit /explicit.jinja"));
        assert!(joined.contains("--token-source none"));
        // gguf subcommand args come after the subcommand
        let gguf_pos = args.iter().position(|a| a == "gguf").unwrap();
        let tok_pos = args.iter().position(|a| a == "--tok-model-id").unwrap();
        let dtype_pos = args.iter().position(|a| a == "--dtype").unwrap();
        let msl_pos = args.iter().position(|a| a == "--max-seq-len").unwrap();
        let mbs_pos = args.iter().position(|a| a == "--max-batch-size").unwrap();
        assert!(
            tok_pos > gguf_pos && dtype_pos > gguf_pos && msl_pos > gguf_pos && mbs_pos > gguf_pos
        );
        assert_eq!(args[msl_pos + 1], "8192");
        assert_eq!(args[dtype_pos + 1], "bf16");
    }

    #[test]
    fn auto_and_none_values_are_omitted() {
        let config = MistralrsConfig {
            dtype: "auto".into(),
            in_situ_quant: "none".into(),
            paged_cache_type: "auto".into(),
            seed: -1,
            ..Default::default()
        };
        let args = build_server_args(&config, 1, "/m", "x.gguf");
        assert!(!args.contains(&"--dtype".to_string()));
        assert!(!args.contains(&"--isq".to_string()));
        assert!(!args.contains(&"--pa-cache-type".to_string()));
        assert!(!args.contains(&"--seed".to_string()));
    }
}
