use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::state::AppState;
use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use serde_json::json;
use tauri::{Emitter, Runtime, State};

/// Extract whisper-server (and required DLLs) from the downloaded zip archive.
///
/// Expects `<jan_data>/voice/whisper/whisper-bin-x64.zip` to already exist.
/// Extracts only the files needed to run the server into the same directory.
#[tauri::command]
pub async fn voice_extract_whisper_zip<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let jan_data = get_jan_data_folder_path(app);
    let whisper_dir = PathBuf::from(&jan_data).join("voice").join("whisper");
    let zip_path = whisper_dir.join("whisper-bin-x64.zip");

    if !zip_path.exists() {
        return Err(format!("Zip not found at {}", zip_path.display()));
    }

    let file = std::fs::File::open(&zip_path)
        .map_err(|e| format!("Failed to open zip: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read zip: {e}"))?;

    // Files to extract (inside zip they live under Release/)
    let needed = [
        "Release/whisper-server.exe",
        "Release/whisper.dll",
        "Release/ggml.dll",
        "Release/ggml-base.dll",
        "Release/ggml-cpu.dll",
    ];

    for name in &needed {
        let mut entry = match archive.by_name(name) {
            Ok(e) => e,
            Err(_) => continue, // skip if not present (e.g. on different zip variants)
        };
        // Strip the "Release/" prefix for the destination filename
        let filename = std::path::Path::new(name)
            .file_name()
            .ok_or_else(|| format!("Bad entry name: {name}"))?;
        let dest = whisper_dir.join(filename);
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| format!("Failed to create {}: {e}", dest.display()))?;
        io::copy(&mut entry, &mut out)
            .map_err(|e| format!("Failed to extract {name}: {e}"))?;
    }

    log::info!("[voice] Extracted whisper-server from zip");
    Ok(())
}

/// Start the Whisper.cpp inference server as a child process.
///
/// The whisper-server binary and model file are expected at:
///   `<jan_data_folder>/voice/whisper/whisper-server[.exe]`
///   `<jan_data_folder>/voice/whisper/ggml-<model_size>.bin`
///
/// If the binary is missing the command returns an error; the TypeScript
/// extension is responsible for downloading the binary via DownloadManager
/// before invoking this command.
#[tauri::command]
pub async fn voice_start_whisper_server<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    port: u16,
    model_size: String,
) -> Result<(), String> {
    let jan_data = get_jan_data_folder_path(app.clone());
    let voice_dir = PathBuf::from(&jan_data).join("voice").join("whisper");

    let binary_name = if cfg!(windows) {
        "whisper-server.exe"
    } else {
        "whisper-server"
    };
    let binary_path = voice_dir.join(binary_name);
    if !binary_path.exists() {
        return Err(format!(
            "Whisper server binary not found at {}. Download it first.",
            binary_path.display()
        ));
    }

    let model_file = voice_dir.join(format!("ggml-{}.bin", model_size));
    if !model_file.exists() {
        return Err(format!(
            "Whisper model file not found at {}. Download it first.",
            model_file.display()
        ));
    }

    log::info!(
        "[voice] Starting whisper-server: binary={} model={} port={}",
        binary_path.display(),
        model_file.display(),
        port
    );

    let mut processes = state.voice_processes.lock().await;
    // Kill any existing instance before starting a new one
    processes.kill_whisper();

    let mut child = Command::new(&binary_path)
        .arg("--port")
        .arg(port.to_string())
        .arg("--model")
        .arg(&model_file)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn whisper-server: {e}"))?;

    // Forward stdout + stderr to log and emit voice-progress events to the UI
    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log::info!("[whisper-server] {line}");
                let _ = app_clone.emit("voice-progress", json!({ "stage": "stt", "message": line }));
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("[whisper-server] {line}");
                let _ = app_clone.emit("voice-progress", json!({ "stage": "stt", "message": line }));
            }
        });
    }

    processes.whisper = Some(child);
    log::info!("[voice] Whisper server spawned on port {port}");
    Ok(())
}

/// Ping a local server URL from the Rust side.
///
/// The Tauri webview sandbox on Windows blocks direct `fetch()` calls to
/// localhost, so readiness polling is routed through this command instead.
///
/// Return values:
///   -1  = connection refused / network error (server process not yet up)
///    0  = HTTP 503 — server is up but explicitly not ready (e.g. model loading)
///    1  = any other HTTP response (2xx, 4xx) — server is up and accepting work
///    2  = HTTP 5xx other than 503 — server is up but permanently errored
#[tauri::command]
pub async fn voice_ping_server(url: String) -> i32 {
    // 30 s per attempt — whisper.cpp accepts TCP connections immediately but
    // queues HTTP requests until the model finishes loading, so a short timeout
    // fires before the server is actually ready.
    match reqwest::Client::new()
        .head(&url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
    {
        Ok(resp) => {
            let s = resp.status().as_u16();
            if s == 503 {
                log::debug!("[voice] ping loading ({url}): 503");
                0
            } else if s >= 500 {
                log::debug!("[voice] ping server-error ({url}): {s}");
                2
            } else {
                log::debug!("[voice] ping OK ({url}): {s}");
                1
            }
        }
        Err(e) => {
            log::debug!("[voice] ping conn-error ({url}): {e}");
            -1
        }
    }
}

/// Stop the Whisper.cpp server child process.
#[tauri::command]
pub async fn voice_stop_whisper_server(state: State<'_, AppState>) -> Result<(), String> {
    let mut processes = state.voice_processes.lock().await;
    processes.kill_whisper();
    log::info!("[voice] Whisper server stopped");
    Ok(())
}

/// Start the Kokoro-ONNX TTS server as a child process.
///
/// The kokoro-server binary is expected at:
///   `<jan_data_folder>/voice/kokoro/kokoro-server[.exe]`
#[tauri::command]
pub async fn voice_start_kokoro_server<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    port: u16,
) -> Result<(), String> {
    let jan_data = get_jan_data_folder_path(app.clone());
    let voice_dir = PathBuf::from(&jan_data).join("voice").join("kokoro");

    let binary_name = if cfg!(windows) {
        "kokoro-server.exe"
    } else {
        "kokoro-server"
    };
    let binary_path = voice_dir.join(binary_name);
    if !binary_path.exists() {
        return Err(format!(
            "Kokoro server binary not found at {}. Download it first.",
            binary_path.display()
        ));
    }

    let mut processes = state.voice_processes.lock().await;
    processes.kill_kokoro();

    let mut child = Command::new(&binary_path)
        .arg("--port")
        .arg(port.to_string())
        .arg("--model-dir")
        .arg(&voice_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn kokoro-server: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log::info!("[kokoro-server] {line}");
                let _ = app_clone.emit("voice-progress", json!({ "stage": "tts", "message": line }));
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("[kokoro-server] {line}");
                let _ = app_clone.emit("voice-progress", json!({ "stage": "tts", "message": line }));
            }
        });
    }

    processes.kokoro = Some(child);
    log::info!("[voice] Kokoro server started on port {port}");
    Ok(())
}

/// Stop the Kokoro-ONNX server child process.
#[tauri::command]
pub async fn voice_stop_kokoro_server(state: State<'_, AppState>) -> Result<(), String> {
    let mut processes = state.voice_processes.lock().await;
    processes.kill_kokoro();
    log::info!("[voice] Kokoro server stopped");
    Ok(())
}

/// Embedded Python server script for Qwen3-TTS — written to disk on first start.
const QWEN3TTS_SERVER_SCRIPT: &str = r#"#!/usr/bin/env python3
"""
Qwen3-TTS synthesis server for Jan voice call integration.
Exposes:
  HEAD  /synthesize  -> 200 (ready) | 503 (loading) | 500 (load failed)
  POST  /synthesize  { "text": "...", "voice": "<speaker>", "language": "<lang>" }
                     -> { "audio_base64": "...", "duration_ms": 1234 }
  GET   /health      -> { "status": "ok" | "loading" | "error", "error": "..." }
"""
import argparse, base64, io, json, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=18767)
parser.add_argument("--model-dir", required=True, help="Local directory containing downloaded model files")
args = parser.parse_args()

model = None
model_error = None
_model_loading = True  # True while thread is running; False when done (success or fail)


def _load_model():
    global model, model_error, _model_loading
    try:
        import soundfile  # ensure soundfile available before loading model
        from faster_qwen3_tts import FasterQwen3TTS

        # FasterQwen3TTS auto-detects CUDA and handles dtype internally.
        # Requires: pip install faster-qwen3-tts
        # For RTX 50xx (Blackwell), install cu128 PyTorch first:
        #   pip install "torch>=2.7.0" --index-url https://download.pytorch.org/whl/cu128
        model = FasterQwen3TTS.from_pretrained(args.model_dir, local_files_only=True)
        print(f"[qwen3tts] Model loaded from {args.model_dir}", flush=True)
    except Exception as e:
        model_error = str(e)
        print(f"[qwen3tts] ERROR loading model: {e}", file=sys.stderr, flush=True)
    finally:
        _model_loading = False


# Load model in background so the HTTP server can bind immediately.
# HEAD /synthesize returns 503 while loading, 200 when ready, 500 if failed.
threading.Thread(target=_load_model, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        if model is not None:
            code = 200       # ready
        elif _model_loading:
            code = 503       # still loading — caller should keep polling
        else:
            code = 500       # load failed permanently
        self.send_response(code)
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            if model is not None:
                status = "ok"
            elif _model_loading:
                status = "loading"
            else:
                status = "error"
            self._json(200, {"status": status, "error": model_error})
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/synthesize":
            self.send_response(404)
            self.end_headers()
            return
        if model is None:
            self._json(503 if _model_loading else 500,
                       {"error": model_error or "model not loaded"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        text = body.get("text", "")
        speaker = body.get("voice", "Ryan")
        language = body.get("language", "Auto")
        try:
            import soundfile as sf
            audio_list, sr = model.generate_custom_voice(text=text, language=language, speaker=speaker)
            buf = io.BytesIO()
            sf.write(buf, audio_list[0], sr, format="WAV")
            audio_b64 = base64.b64encode(buf.getvalue()).decode()
            duration_ms = int(len(wavs[0]) / sr * 1000)
            self._json(200, {"audio_base64": audio_b64, "duration_ms": duration_ms})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, code, data):
        resp = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)

    def log_message(self, *args):
        pass


print(f"[qwen3tts] Listening on 127.0.0.1:{args.port}", flush=True)
HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
"#;

/// One-shot Python script that downloads a Qwen3-TTS model snapshot to a local directory.
const QWEN3TTS_DOWNLOADER_SCRIPT: &str = r#"#!/usr/bin/env python3
"""Download a Qwen3-TTS model snapshot to a local directory via huggingface_hub."""
import argparse, sys

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True, help="HuggingFace repo id")
parser.add_argument("--dest", required=True, help="Local destination directory")
args = parser.parse_args()

print(f"[qwen3tts-dl] Downloading {args.model} -> {args.dest}", flush=True)
try:
    from huggingface_hub import snapshot_download
    path = snapshot_download(
        repo_id=args.model,
        local_dir=args.dest,
        local_dir_use_symlinks=False,
    )
    print(f"[qwen3tts-dl] Done: {path}", flush=True)
except Exception as e:
    print(f"[qwen3tts-dl] ERROR: {e}", file=sys.stderr, flush=True)
    sys.exit(1)
"#;

/// Compute the local model directory for a given Qwen3-TTS HF model ID.
/// Files are stored at `<jan_data>/voice/qwen3tts/models/<sanitized-id>/`.
fn qwen3tts_model_dir_from(jan_data: &PathBuf, model_id: &str) -> PathBuf {
    // Replace `/` with `--` (mirrors HuggingFace cache naming convention).
    let sanitized = model_id.replace('/', "--");
    jan_data.join("voice").join("qwen3tts").join("models").join(sanitized)
}

/// Find the Python 3 executable in PATH.
/// Returns the command name if found, None otherwise.
fn find_python() -> Option<String> {
    for candidate in ["python3", "python"] {
        if Command::new(candidate)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Start the Qwen3-TTS Python synthesis server.
///
/// Writes the embedded server script to `<jan_data>/voice/qwen3tts/server.py`
/// on first call, then spawns `python server.py --port <port> --model <model>`.
///
/// Requires Python 3 and `pip install qwen-tts soundfile` in the active
/// Python environment.
#[tauri::command]
pub async fn voice_start_qwen3tts_server<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    port: u16,
    model: String,
) -> Result<(), String> {
    let python = find_python()
        .ok_or_else(|| "Python 3 not found in PATH. Install Python 3 to use Qwen3-TTS.".to_string())?;

    let jan_data = get_jan_data_folder_path(app.clone());
    let qwen3tts_dir = PathBuf::from(&jan_data).join("voice").join("qwen3tts");
    std::fs::create_dir_all(&qwen3tts_dir)
        .map_err(|e| format!("Failed to create qwen3tts dir: {e}"))?;

    // Require the model to be pre-downloaded from the Settings page.
    let model_dir = qwen3tts_model_dir_from(&PathBuf::from(&jan_data), &model);
    if !model_dir.join("config.json").exists() {
        return Err(format!(
            "Qwen3-TTS model not found at {}. Download it from Voice Settings first.",
            model_dir.display()
        ));
    }

    let script_path = qwen3tts_dir.join("server.py");
    std::fs::write(&script_path, QWEN3TTS_SERVER_SCRIPT)
        .map_err(|e| format!("Failed to write qwen3tts server script: {e}"))?;

    let mut processes = state.voice_processes.lock().await;
    processes.kill_qwen3tts();

    let mut child = Command::new(&python)
        .arg(&script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg("--model-dir")
        .arg(&model_dir)
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn qwen3tts server: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                log::info!("[qwen3tts] {line}");
                let _ = app_clone.emit("voice-progress", json!({ "stage": "tts", "message": line }));
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log::warn!("[qwen3tts] {line}");
                let _ = app_clone.emit("voice-progress", json!({ "stage": "tts", "message": line }));
            }
        });
    }

    processes.qwen3tts = Some(child);
    log::info!("[voice] Qwen3-TTS server started on port {port} with model dir {}", model_dir.display());
    Ok(())
}

/// Stop the Qwen3-TTS server child process.
#[tauri::command]
pub async fn voice_stop_qwen3tts_server(state: State<'_, AppState>) -> Result<(), String> {
    let mut processes = state.voice_processes.lock().await;
    processes.kill_qwen3tts();
    log::info!("[voice] Qwen3-TTS server stopped");
    Ok(())
}

/// Download a Qwen3-TTS model snapshot from HuggingFace to local disk.
///
/// Streams download progress to `voice-progress` events (stage = "tts-download").
/// This command blocks until the download completes or fails — call it from the
/// settings page, not from the voice call hot path.
#[tauri::command]
pub async fn voice_download_qwen3tts_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    model: String,
) -> Result<(), String> {
    let python = find_python()
        .ok_or_else(|| "Python 3 not found in PATH. Install Python 3 first.".to_string())?;

    let jan_data = get_jan_data_folder_path(app.clone());
    let qwen3tts_dir = PathBuf::from(&jan_data).join("voice").join("qwen3tts");
    std::fs::create_dir_all(&qwen3tts_dir)
        .map_err(|e| format!("Failed to create qwen3tts dir: {e}"))?;

    let script_path = qwen3tts_dir.join("downloader.py");
    std::fs::write(&script_path, QWEN3TTS_DOWNLOADER_SCRIPT)
        .map_err(|e| format!("Failed to write downloader script: {e}"))?;

    let dest = qwen3tts_model_dir_from(&PathBuf::from(&jan_data), &model);
    std::fs::create_dir_all(&dest)
        .map_err(|e| format!("Failed to create model dir: {e}"))?;

    log::info!("[voice] Starting Qwen3-TTS model download: model={model} dest={}", dest.display());

    let mut child = tokio::process::Command::new(&python)
        .arg(&script_path)
        .arg("--model").arg(&model)
        .arg("--dest").arg(&dest)
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn downloader: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::info!("[qwen3tts-dl] {line}");
                let _ = app_clone.emit("voice-progress", json!({ "stage": "tts-download", "message": line }));
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[qwen3tts-dl] {line}");
                let _ = app_clone.emit("voice-progress", json!({ "stage": "tts-download", "message": line }));
            }
        });
    }

    let status = child.wait().await
        .map_err(|e| format!("Downloader process error: {e}"))?;

    if !status.success() {
        return Err(format!(
            "Model download failed (exit {}). Check logs for details.",
            status.code().unwrap_or(-1)
        ));
    }

    log::info!("[voice] Qwen3-TTS model downloaded to {}", dest.display());
    Ok(())
}

/// Check which voice dependency binaries are present on disk.
///
/// Returns a JSON-serialisable struct so the settings UI can render
/// per-item install status without needing to know the exact paths.
#[derive(serde::Serialize)]
pub struct VoiceDependencyStatus {
    pub whisper_server: bool,
    pub kokoro_server: bool,
    /// Which Whisper model sizes have their `.bin` file downloaded.
    pub whisper_models: std::collections::HashMap<String, bool>,
    /// Absolute path to the jan data folder (shown in UI for reference).
    pub data_folder: String,
    /// Whether Python 3 was found in PATH.
    pub python_available: bool,
    /// The python executable name found (e.g. "python3" or "python"), if any.
    pub python_executable: Option<String>,
    /// Whether the Qwen3-TTS server script has been written to disk.
    pub qwen3tts_server_script: bool,
    /// Sanitized directory names (model IDs with '/' replaced by '--') for
    /// all Qwen3-TTS models that have a config.json on disk.
    pub qwen3tts_downloaded_models: Vec<String>,
    /// Whether the Whisper server process is currently running.
    pub whisper_running: bool,
    /// Whether the Kokoro server process is currently running.
    pub kokoro_running: bool,
    /// Whether the Qwen3-TTS server process is currently running.
    pub qwen3tts_running: bool,
}

#[tauri::command]
pub async fn voice_check_dependencies<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<VoiceDependencyStatus, String> {
    let jan_data = get_jan_data_folder_path(app);
    let whisper_dir = PathBuf::from(&jan_data).join("voice").join("whisper");
    let kokoro_dir = PathBuf::from(&jan_data).join("voice").join("kokoro");
    let qwen3tts_dir = PathBuf::from(&jan_data).join("voice").join("qwen3tts");

    let binary_ext = if cfg!(windows) { ".exe" } else { "" };

    let whisper_server = whisper_dir
        .join(format!("whisper-server{binary_ext}"))
        .exists();
    let kokoro_server = kokoro_dir
        .join(format!("kokoro-server{binary_ext}"))
        .exists();

    let model_sizes = ["tiny", "base", "small", "medium"];
    let whisper_models = model_sizes
        .iter()
        .map(|size| {
            let exists = whisper_dir.join(format!("ggml-{size}.bin")).exists();
            (size.to_string(), exists)
        })
        .collect();

    let python_executable = find_python();
    let python_available = python_executable.is_some();
    let qwen3tts_server_script = qwen3tts_dir.join("server.py").exists();

    // Collect all downloaded Qwen3-TTS models (subdirs containing config.json).
    let qwen3tts_downloaded_models: Vec<String> = qwen3tts_dir.join("models")
        .read_dir()
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir() && e.path().join("config.json").exists())
                .filter_map(|e| e.file_name().to_str().map(|s| s.to_owned()))
                .collect()
        })
        .unwrap_or_default();

    // Check live process state.
    let (whisper_running, kokoro_running, qwen3tts_running) = {
        let mut processes = state.voice_processes.lock().await;
        (
            processes.is_whisper_running(),
            processes.is_kokoro_running(),
            processes.is_qwen3tts_running(),
        )
    };

    Ok(VoiceDependencyStatus {
        whisper_server,
        kokoro_server,
        whisper_models,
        data_folder: jan_data.to_string_lossy().into_owned(),
        python_available,
        python_executable,
        qwen3tts_server_script,
        qwen3tts_downloaded_models,
        whisper_running,
        kokoro_running,
        qwen3tts_running,
    })
}

/// Remove a downloaded Qwen3-TTS model directory from disk.
#[tauri::command]
pub async fn voice_remove_qwen3tts_model<R: Runtime>(
    app: tauri::AppHandle<R>,
    model_id: String,
) -> Result<(), String> {
    let jan_data = get_jan_data_folder_path(app);
    let model_dir = qwen3tts_model_dir_from(&PathBuf::from(&jan_data), &model_id);
    if model_dir.exists() {
        tokio::fs::remove_dir_all(&model_dir)
            .await
            .map_err(|e| format!("Failed to remove model directory: {e}"))?;
        log::info!("[voice] Removed Qwen3-TTS model: {model_id}");
    }
    Ok(())
}

// ── HTTP proxy commands ───────────────────────────────────────────────────────
// Audio data (transcription, synthesis) goes through Rust, not the webview.
// Server readiness polling uses the webview's native fetch() since it only
// needs a TCP-level connection check and any HTTP response means "server up".

/// Transcribe base64-encoded audio via the local Whisper.cpp server.
/// Returns the trimmed transcript text.
#[tauri::command]
pub async fn voice_transcribe(
    audio_base64: String,
    format: String,
    port: u16,
) -> Result<String, String> {
    use base64::Engine as _;
    let audio_bytes = base64::engine::general_purpose::STANDARD
        .decode(&audio_base64)
        .map_err(|e| format!("Base64 decode error: {e}"))?;

    let mime = format!("audio/{format}");
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(format!("audio.{format}"))
        .mime_str(&mime)
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("response_format", "json");

    let url = format!("http://127.0.0.1:{port}/inference");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Whisper request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Whisper inference failed: {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = json["text"].as_str().unwrap_or("").trim().to_string();
    // Whisper emits placeholder tokens for silence — treat them as empty.
    let blank_tokens = ["[BLANK_AUDIO]", "[ Silence ]", "(silence)", "[ BLANK_AUDIO ]"];
    if blank_tokens.iter().any(|t| text.eq_ignore_ascii_case(t)) {
        return Ok(String::new());
    }
    Ok(text)
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct KokoroPhoneme {
    pub phoneme: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct KokoroSynthResult {
    pub audio_base64: String,
    pub duration_ms: Option<u64>,
    pub phonemes: Option<Vec<KokoroPhoneme>>,
}

/// Synthesize speech via the local Kokoro-ONNX server.
/// Returns base64-encoded WAV audio, duration, and optional phoneme timestamps.
#[tauri::command]
pub async fn voice_synthesize_kokoro(
    text: String,
    voice: String,
    speed: f64,
    port: u16,
) -> Result<KokoroSynthResult, String> {
    let url = format!("http://127.0.0.1:{port}/synthesize");
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "text": text, "voice": voice, "speed": speed });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Kokoro request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Kokoro synthesis failed: {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let phonemes = json["phonemes"].as_array().map(|arr| {
        arr.iter()
            .filter_map(|p| {
                Some(KokoroPhoneme {
                    phoneme: p["phoneme"].as_str()?.to_string(),
                    start_ms: p["start_ms"].as_u64().unwrap_or(0),
                    end_ms: p["end_ms"].as_u64().unwrap_or(0),
                })
            })
            .collect()
    });
    Ok(KokoroSynthResult {
        audio_base64: json["audio_base64"].as_str().unwrap_or("").to_string(),
        duration_ms: json["duration_ms"].as_u64(),
        phonemes,
    })
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct Qwen3TTSSynthResult {
    pub audio_base64: String,
    pub duration_ms: Option<u64>,
}

/// Synthesize speech via the local Qwen3-TTS Python server.
#[tauri::command]
pub async fn voice_synthesize_qwen3tts(
    text: String,
    speaker: String,
    language: String,
    port: u16,
) -> Result<Qwen3TTSSynthResult, String> {
    let url = format!("http://127.0.0.1:{port}/synthesize");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "text": text,
        "speaker": speaker,
        "language": language,
    });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Qwen3-TTS request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Qwen3-TTS synthesis failed: {}", resp.status()));
    }
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(Qwen3TTSSynthResult {
        audio_base64: json["audio_base64"].as_str().unwrap_or("").to_string(),
        duration_ms: json["duration_ms"].as_u64(),
    })
}
