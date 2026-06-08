use std::process::Stdio;

use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::oneshot;

use crate::core::state::AppState;

/// Payload emitted to the frontend for each line of output from `hermes`.
/// The `session_id` routes events to the correct hook instance.
#[derive(Debug, Clone, serde::Serialize)]
struct HermesAgentEvent {
    event: serde_json::Value,
    session_id: String,
}

/// Spawn a Hermes agent turn and stream stdout back to the frontend via the
/// `hermes://agent-event` Tauri event channel.
///
/// Uses `hermes chat --quiet --yolo -q <prompt>`.  For multi-turn
/// conversations, pass `hermes_session = "continue"` which prepends
/// `--continue` so Hermes resumes the most-recent session.
///
/// Returns `"continue"` after each successful turn so the caller can persist
/// it and pass it back on the next turn.
#[tauri::command]
pub async fn hermes_run_turn<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    prompt: String,
    // "" / None → new session; "continue" → resume most-recent session via --continue.
    hermes_session: Option<String>,
    working_dir: Option<String>,
    binary_path: Option<String>,
    model: Option<String>,
    provider: Option<String>,
) -> Result<String, String> {
    let current_hermes_session = hermes_session.unwrap_or_default();
    let resume = current_hermes_session.trim() == "continue";

    // Build args: optional --continue (global) then subcommand + flags.
    let mut args: Vec<String> = Vec::new();
    if resume {
        args.push("--continue".into());
    }
    args.push("chat".into());
    args.push("--quiet".into());
    args.push("--yolo".into());

    if let Some(ref m) = model {
        if !m.trim().is_empty() {
            args.push("--model".into());
            args.push(m.clone());
        }
    }
    if let Some(ref p) = provider {
        if !p.trim().is_empty() {
            args.push("--provider".into());
            args.push(p.clone());
        }
    }

    args.push("-q".into());
    args.push(prompt.clone());

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut guard = state.hermes_cancel.lock().await;
        *guard = Some(cancel_tx);
    }

    let binary = binary_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("hermes");

    let mut cmd = TokioCommand::new(binary);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(ref dir) = working_dir {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            let expanded = if trimmed == "~" || trimmed.starts_with("~/") {
                if let Some(home) = std::env::var_os("HOME") {
                    let rest = trimmed.trim_start_matches('~');
                    format!("{}{}", home.to_string_lossy(), rest)
                } else {
                    trimmed.to_string()
                }
            } else {
                trimmed.to_string()
            };
            cmd.current_dir(expanded);
        }
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Failed to spawn {binary}: {e}. Is the Hermes Agent CLI installed and on PATH?"
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or("hermes process produced no stdout")?;

    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let read_result: Result<(), String> = tokio::select! {
        biased;

        // Cancellation: kill child, emit a synthetic cancelled event.
        _ = cancel_rx => {
            child.kill().await.ok();
            let _ = app.emit(
                "hermes://agent-event",
                &HermesAgentEvent {
                    event: serde_json::json!({
                        "type": "result",
                        "subtype": "cancelled",
                    }),
                    session_id: session_id.clone(),
                },
            );
            Ok(())
        }

        // Normal path: stream each stdout line as a text_chunk event.
        result = async {
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        if line.is_empty() {
                            continue;
                        }
                        let _ = app.emit(
                            "hermes://agent-event",
                            &HermesAgentEvent {
                                event: serde_json::json!({
                                    "type": "text_chunk",
                                    "text": line,
                                }),
                                session_id: session_id.clone(),
                            },
                        );
                    }
                    Ok(None) => break,
                    Err(e) => return Err(e.to_string()),
                }
            }
            Ok::<(), String>(())
        } => result,
    };

    child.wait().await.ok();

    {
        let mut guard = state.hermes_cancel.lock().await;
        *guard = None;
    }

    read_result?;

    // Signal successful completion to the frontend.
    let _ = app.emit(
        "hermes://agent-event",
        &HermesAgentEvent {
            event: serde_json::json!({
                "type": "result",
                "subtype": "success",
            }),
            session_id: session_id.clone(),
        },
    );

    // Return "continue" so the next turn can pick up this session.
    Ok("continue".to_string())
}

/// Signal the currently-running `hermes_run_turn` to terminate early.
#[tauri::command]
pub async fn hermes_stop_turn(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.hermes_cancel.lock().await;
    if let Some(tx) = guard.take() {
        tx.send(()).ok();
    }
    Ok(())
}
