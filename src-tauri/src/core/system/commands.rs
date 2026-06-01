use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_llamacpp::cleanup_llama_processes;
use toml_edit::{value, Array, DocumentMut, Item, Table, Value as TomlValue};

use crate::core::app::commands::{
    default_data_folder_path, get_jan_data_folder_path, update_app_configuration,
};
use crate::core::app::constants::{
    JAN_DATA_DIRS_COMMON, JAN_DATA_DIRS_CONVERSATIONS, JAN_DATA_DIRS_MODELS,
    JAN_DATA_FILES_CONFIGS, JAN_DATA_FILES_SETTINGS,
};
use crate::core::app::models::AppConfiguration;
use crate::core::mcp::helpers::{stop_mcp_servers_with_context, ShutdownContext};
use crate::core::state::AppState;

fn is_safe_to_delete(path: &std::path::Path) -> bool {
    let count = path.components().count();
    count >= 3
}

fn remove_dir(data_folder: &std::path::Path, name: &str) {
    let path = data_folder.join(name);
    if path.is_dir() {
        log::info!("Removing directory: {}", path.display());
        if let Err(e) = fs::remove_dir_all(&path) {
            log::warn!("Failed to remove {}: {e}", path.display());
        }
    }
}

fn remove_file(data_folder: &std::path::Path, name: &str) {
    let path = data_folder.join(name);
    if path.is_file() {
        log::info!("Removing file: {}", path.display());
        if let Err(e) = fs::remove_file(&path) {
            log::warn!("Failed to remove {}: {e}", path.display());
        }
    }
}

/// Delete conversations and user data (threads, assistants).
fn delete_conversations(data_folder: &std::path::Path) {
    log::info!("Deleting conversations (threads, assistants)");
    for dir in JAN_DATA_DIRS_CONVERSATIONS {
        remove_dir(data_folder, dir);
    }
}

/// Delete downloaded models, engine binaries, and configuration files
/// (engine settings, MCP config, etc.).
fn delete_models_and_configs(data_folder: &std::path::Path) {
    log::info!("Deleting models, engines, and configurations");
    for dir in JAN_DATA_DIRS_MODELS {
        remove_dir(data_folder, dir);
    }
    for file in JAN_DATA_FILES_CONFIGS {
        remove_file(data_folder, file);
    }
}

/// Delete extensions, logs, caches — always cleaned during any reset.
fn delete_common_data(data_folder: &std::path::Path) {
    log::info!("Deleting common data (extensions, logs, caches)");
    for dir in JAN_DATA_DIRS_COMMON {
        remove_dir(data_folder, dir);
    }
}

/// Delete cross-category settings (store.json) — only during a full wipe
/// when the user is not keeping any data.
fn delete_settings(data_folder: &std::path::Path) {
    log::info!("Deleting cross-category settings (store.json)");
    for file in JAN_DATA_FILES_SETTINGS {
        remove_file(data_folder, file);
    }
}

/// Detect the user's default shell and return the appropriate env file path.
/// Returns (shell_name, env_file_path).
fn detect_shell_env_file(home_dir: &str, is_macos: bool) -> (&'static str, String) {
    let shell = std::env::var("SHELL").unwrap_or_default();
    if shell.ends_with("/bash") {
        // macOS uses login shells in Terminal, so ~/.bash_profile is sourced.
        // Linux interactive shells source ~/.bashrc.
        let file = if is_macos {
            format!("{}/.bash_profile", home_dir)
        } else {
            format!("{}/.bashrc", home_dir)
        };
        ("bash", file)
    } else {
        // Default to zsh (macOS default since Catalina)
        ("zsh", format!("{}/.zshenv", home_dir))
    }
}

// Helper function to write env vars to a shell config file
fn write_env_to_shell(env_file_path: &str, env_vars: &[(String, String)]) -> Result<(), String> {
    let marker = "# Jan Local API Server - Claude Code Config";
    let new_entries: String = env_vars
        .iter()
        .map(|(k, v)| format!("export {}='{}'\n", k, v))
        .collect();

    let existing_content = std::fs::read_to_string(env_file_path).unwrap_or_default();
    let cleaned: Vec<&str> = existing_content
        .split('\n')
        .filter(|line| {
            // Remove Jan config markers and existing ANTHROPIC env vars to replace them
            !line.starts_with(marker)
                && !line.starts_with("# Jan Local API Server")
                && !line.starts_with("export ANTHROPIC_")
        })
        .collect();

    let new_content = format!("{}\n{}\n{}\n", marker, new_entries, marker);

    let final_content = cleaned.join("\n") + &new_content;
    std::fs::write(env_file_path, &final_content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn factory_reset<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    keep_app_data: Option<bool>,
    keep_models_and_configs: Option<bool>,
) {
    let keep_app_data = keep_app_data.unwrap_or(false);
    let keep_models_and_configs = keep_models_and_configs.unwrap_or(false);

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let windows = app_handle.webview_windows();
        for (label, window) in windows.iter() {
            window.close().unwrap_or_else(|_| {
                log::warn!("Failed to close window: {label:?}");
            });
        }
    }
    let data_folder = get_jan_data_folder_path(app_handle.clone());
    log::info!(
        "Factory reset (keep_app_data={}, keep_models_and_configs={}), data folder: {:?}",
        keep_app_data,
        keep_models_and_configs,
        data_folder
    );

    tauri::async_runtime::block_on(async {
        let _ =
            stop_mcp_servers_with_context(&app_handle, &state, ShutdownContext::FactoryReset).await;

        {
            let mut active_servers = state.mcp_active_servers.lock().await;
            active_servers.clear();
        }

        use crate::core::mcp::lockfile::cleanup_own_locks;
        if let Err(e) = cleanup_own_locks(&app_handle) {
            log::warn!("Failed to cleanup lock files: {}", e);
        }
        let _ = cleanup_llama_processes(app_handle.clone()).await;

        if data_folder.exists() {
            if !is_safe_to_delete(&data_folder) {
                log::error!(
                    "Refusing factory reset: path is too close to filesystem root: {}",
                    data_folder.display()
                );
                return;
            }

            // Always clean common data (extensions, logs, caches)
            delete_common_data(&data_folder);

            // Delete conversations (threads, assistants) unless user chose to keep it
            if !keep_app_data {
                delete_conversations(&data_folder);
            }

            // Delete models and configs unless user chose to keep them
            if !keep_models_and_configs {
                delete_models_and_configs(&data_folder);
            }

            // store.json spans all categories; only wipe it when nothing is kept
            if !keep_app_data && !keep_models_and_configs {
                delete_settings(&data_folder);
            }
        }

        // Reset app configuration to defaults unless user chose to keep configs
        if !keep_models_and_configs {
            let mut default_config = AppConfiguration::default();
            default_config.data_folder = default_data_folder_path(app_handle.clone());
            let _ = update_app_configuration(app_handle.clone(), default_config);
        }

        app_handle.restart();
    });
}

#[tauri::command]
pub fn relaunch<R: Runtime>(app: AppHandle<R>) {
    app.restart()
}

#[tauri::command]
pub fn open_app_directory<R: Runtime>(app: AppHandle<R>) {
    let app_path = app.path().app_data_dir().unwrap();
    if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(app_path)
            .status()
            .expect("Failed to open app directory");
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(app_path)
            .status()
            .expect("Failed to open app directory");
    } else {
        std::process::Command::new("xdg-open")
            .arg(app_path)
            .status()
            .expect("Failed to open app directory");
    }
}

#[tauri::command]
pub fn open_file_explorer(path: String) {
    let path = PathBuf::from(path);
    if cfg!(target_os = "windows") {
        // Normalize extended-length paths (\\?\...) for explorer compatibility.
        let mut path_str = path.to_string_lossy().into_owned();
        if let Some(stripped) = path_str.strip_prefix(r"\\?\UNC\") {
            path_str = format!(r"\\{}", stripped);
        } else if let Some(stripped) = path_str.strip_prefix(r"\\?\") {
            path_str = stripped.to_string();
        }
        std::process::Command::new("explorer")
            .arg(path_str)
            .status()
            .expect("Failed to open file explorer");
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(path)
            .status()
            .expect("Failed to open file explorer");
    } else {
        std::process::Command::new("xdg-open")
            .arg(path)
            .status()
            .expect("Failed to open file explorer");
    }
}

#[tauri::command]
pub async fn read_logs<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let log_path = get_jan_data_folder_path(app).join("logs").join("app.log");
    if log_path.exists() {
        let content = fs::read_to_string(log_path).map_err(|e| e.to_string())?;
        Ok(content)
    } else {
        Err("Log file not found".to_string())
    }
}

// check if a system library is available
#[tauri::command]
pub fn is_library_available(library: &str) -> bool {
    match unsafe { libloading::Library::new(library) } {
        Ok(_) => true,
        Err(e) => {
            log::info!("Library {library} is not available: {e}");
            false
        }
    }
}

#[tauri::command]
pub fn launch_claude_code_with_config(
    api_url: String,
    api_key: Option<String>,
    big_model: Option<String>,
    medium_model: Option<String>,
    small_model: Option<String>,
    custom_env_vars: Vec<serde_json::Value>,
) -> Result<(), String> {
    // Clone values for logging before moving
    let api_url_log = api_url.clone();
    let big_model_log = big_model.clone();
    let medium_model_log = medium_model.clone();
    let small_model_log = small_model.clone();

    let mut env_vars: Vec<(String, String)> = Vec::with_capacity(8);
    env_vars.push(("ANTHROPIC_BASE_URL".to_string(), api_url));

    env_vars.push((
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        api_key.unwrap_or_else(|| "jan".to_string()),
    ));

    if let Some(model) = big_model {
        env_vars.push(("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), model));
    }

    if let Some(model) = medium_model {
        env_vars.push(("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(), model));
    }

    if let Some(model) = small_model {
        env_vars.push(("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), model));
    }

    // Add custom env vars from the custom CLI section
    for env in &custom_env_vars {
        if let (Some(key), Some(value)) = (
            env.get("key").and_then(|v| v.as_str()),
            env.get("value").and_then(|v| v.as_str()),
        ) {
            env_vars.push((key.to_string(), value.to_string()));
        }
    }

    log::info!(
        "Launching Claude Code with API URL: {}, models: opus={:?}, sonnet={:?}, haiku={:?}, custom_envs={}",
        api_url_log,
        big_model_log,
        medium_model_log,
        small_model_log,
        custom_env_vars.len()
    );

    // Build the command environment
    // Export environment variables to the user's shell config file

    if cfg!(target_os = "macos") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, true);
        log::info!(
            "Detected shell: {}, writing env to: {}",
            shell_name,
            env_file_path
        );

        // Try direct write first
        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(&env_file_path)
        {
            Ok(_) => {
                write_env_to_shell(&env_file_path, &env_vars)?;
                return Ok(());
            }
            Err(_) => {
                // Use admin privileges to write
                let marker = "# Jan Local API Server - Claude Code Config";
                let existing_content = std::fs::read_to_string(&env_file_path).unwrap_or_default();
                let cleaned: Vec<&str> = existing_content
                    .split('\n')
                    .filter(|line| {
                        !line.starts_with(marker)
                            && !line.starts_with("# Jan Local API Server")
                            && !line.starts_with("export ANTHROPIC_")
                    })
                    .collect();

                let env_content: String = env_vars
                    .iter()
                    .map(|(k, v)| format!("export {}='{}'\n", k, v))
                    .collect();

                let new_block = format!("{}\n{}", marker, env_content);

                let final_content = cleaned.join("\n") + "\n" + &new_block + marker;

                // Write to a temp file first, then use osascript to move it
                let temp_script_path = format!("{}/.jan_env_update.sh", home_dir);
                std::fs::write(&temp_script_path, &final_content).map_err(|e| e.to_string())?;

                // Use admin privileges to move the temp file
                let script = format!(
                    r#"do shell script "cp '{}' '{}' && rm '{}' && echo 'Env vars written to {}'" with administrator privileges"#,
                    temp_script_path, env_file_path, temp_script_path, env_file_path
                );

                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| e.to_string())?;

                log::info!(
                    "Env vars written to {} with admin privileges",
                    env_file_path
                );
                return Ok(());
            }
        }
    } else if cfg!(target_os = "linux") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, false);
        log::info!(
            "Detected shell: {}, writing env to: {}",
            shell_name,
            env_file_path
        );

        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(&env_file_path)
        {
            Ok(_) => {
                write_env_to_shell(&env_file_path, &env_vars)?;
                return Ok(());
            }
            Err(_) => {
                let jan_config_dir = format!("{}/.config/jan", home_dir);
                let ext = if shell_name == "bash" { "bash" } else { "zsh" };
                let env_file = format!("{}/claude-code-env.{}", jan_config_dir, ext);
                return Err(format!("NEED_PERMISSION:{}", env_file));
            }
        }
    } else {
        // On Windows, set persistent user environment variables using setx
        for (key, value) in &env_vars {
            let output = std::process::Command::new("setx")
                .arg(key)
                .arg(value)
                .output()
                .map_err(|e| e.to_string())?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to set env var {}: {}", key, stderr));
            }
        }

        log::info!("Environment variables set permanently in Windows registry.");
        return Ok(());
    }
}

#[derive(serde::Serialize)]
pub struct CliInstallStatus {
    pub installed: bool,
    pub path: Option<String>,
}

/// Check if the `jan` CLI binary is accessible on PATH, or — failing that —
/// at one of the known install destinations.
///
/// `which`/`where` only sees what the Tauri process's PATH sees. Linux GUI
/// launches typically inherit a minimal PATH (no `~/.local/bin`), and on
/// Windows the registry PATH update from `add_to_path_windows` doesn't apply
/// to the already-running process. Without the fallback probe, a successful
/// install reports `installed: false` after the next remount of Settings.
#[tauri::command]
pub async fn check_jan_cli_installed() -> CliInstallStatus {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let mut cmd = std::process::Command::new(which_cmd);
    cmd.arg("jan");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let path_from_which = match tokio::task::spawn_blocking(move || cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout);
            #[cfg(windows)]
            let path = {
                raw.lines()
                    .map(str::trim)
                    .filter(|p| !p.is_empty() && !p.to_ascii_lowercase().contains("\\target\\"))
                    .next()
                    .map(str::to_string)
                    .or_else(|| {
                        raw.lines()
                            .map(str::trim)
                            .find(|p| !p.is_empty())
                            .map(str::to_string)
                    })
            };
            #[cfg(not(windows))]
            let path = {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            };
            path
        }
        _ => None,
    };

    if let Some(p) = path_from_which {
        return CliInstallStatus {
            installed: true,
            path: Some(p),
        };
    }

    // Fall back to probing the destinations `install_jan_cli_sync` writes to.
    for candidate in jan_cli_install_candidates() {
        if candidate.exists() {
            return CliInstallStatus {
                installed: true,
                path: Some(candidate.to_string_lossy().into_owned()),
            };
        }
    }

    CliInstallStatus {
        installed: false,
        path: None,
    }
}

/// Paths where `install_jan_cli_sync` may have placed the `jan` binary.
fn jan_cli_install_candidates() -> Vec<PathBuf> {
    let bin = if cfg!(windows) { "jan.exe" } else { "jan" };
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(unix)]
    {
        out.push(PathBuf::from("/usr/local/bin").join(bin));
        if let Ok(home) = std::env::var("HOME") {
            out.push(PathBuf::from(home).join(".local").join("bin").join(bin));
        }
    }
    #[cfg(windows)]
    {
        if let Ok(dir) = jan_cli_bin_dir_windows() {
            out.push(dir.join(bin));
        }
    }
    out
}

/// Core install logic — synchronous, no Tauri command overhead.
pub fn install_jan_cli_sync<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<CliInstallStatus, String> {
    let bin_name = if cfg!(windows) {
        "jan-cli.exe"
    } else {
        "jan-cli"
    };
    let dest_bin_name = if cfg!(windows) { "jan.exe" } else { "jan" };
    let resource_bin_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources/bin");
    let bundled = resource_bin_dir.join(bin_name);
    let dest = resource_bin_dir.join(dest_bin_name);

    if !bundled.exists() && !dest.exists() {
        return Err("Jan CLI binary not bundled with this version of Jan.".to_string());
    }

    #[cfg(windows)]
    {
        if bundled.exists() {
            if let Err(e) = std::fs::rename(&bundled, &dest) {
                log::warn!("Could not rename jan-cli.exe to jan.exe: {}", e);
            }
        }
        add_to_path_windows(&resource_bin_dir)?;
        return Ok(CliInstallStatus {
            installed: true,
            path: Some(dest.to_string_lossy().into_owned()),
        });
    }

    #[cfg(unix)]
    {
        let install_dir = jan_cli_install_dir()?;
        std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
        let dest = install_dir.join(dest_bin_name);

        std::fs::copy(&bundled, &dest)
            .map_err(|e| format!("Failed to copy jan to {}: {}", dest.display(), e))?;

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;

        Ok(CliInstallStatus {
            installed: true,
            path: Some(dest.to_string_lossy().into_owned()),
        })
    }
}

/// Copy the bundled `jan` binary to the system PATH (Tauri command wrapper).
#[tauri::command]
pub async fn install_jan_cli<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<CliInstallStatus, String> {
    install_jan_cli_sync(&app_handle)
}

/// Remove the installed `jan` CLI binary.
#[tauri::command]
pub fn uninstall_jan_cli() -> Result<(), String> {
    #[cfg(windows)]
    {
        let bin_dir = jan_cli_bin_dir_windows()?;
        remove_from_path_windows(&bin_dir)?;
        return Ok(());
    }

    #[cfg(unix)]
    {
        let dest = jan_cli_install_dir()?.join("jan");
        if dest.exists() {
            std::fs::remove_file(&dest)
                .map_err(|e| format!("Failed to remove Jan CLI from {}: {}", dest.display(), e))?;
        }
        Ok(())
    }
}

/// Build the cleaned shell-file content with all Jan CC env vars stripped out.
fn build_cleaned_env_content(env_file_path: &str) -> String {
    let existing_content = std::fs::read_to_string(env_file_path).unwrap_or_default();
    let cleaned: Vec<&str> = existing_content
        .split('\n')
        .filter(|line| {
            !line.starts_with("# Jan Local API Server - Claude Code Config")
                && !line.starts_with("# Jan Local API Server")
                && !line.starts_with("export ANTHROPIC_")
        })
        .collect();
    // Trim trailing blank lines left behind by the removed block
    cleaned.join("\n").trim_end().to_string() + "\n"
}

/// Clear all Jan-written Claude Code environment variables from the shell config.
/// Uses the same write-probe + osascript-fallback logic as `launch_claude_code_with_config`.
#[tauri::command]
pub fn clear_claude_code_env() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, true);
        log::info!(
            "Clearing CC env from shell: {}, file: {}",
            shell_name,
            env_file_path
        );

        let cleaned = build_cleaned_env_content(&env_file_path);

        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(&env_file_path)
        {
            Ok(_) => {
                std::fs::write(&env_file_path, &cleaned).map_err(|e| e.to_string())?;
                return Ok(());
            }
            Err(_) => {
                // Write cleaned content to a temp file, then use osascript to move it
                let temp_path = format!("{}/.jan_env_clear.sh", home_dir);
                std::fs::write(&temp_path, &cleaned).map_err(|e| e.to_string())?;

                let script = format!(
                    r#"do shell script "cp '{}' '{}' && rm '{}'" with administrator privileges"#,
                    temp_path, env_file_path, temp_path
                );

                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| e.to_string())?;

                log::info!(
                    "CC env cleared from {} with admin privileges",
                    env_file_path
                );
                return Ok(());
            }
        }
    } else if cfg!(target_os = "linux") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, false);
        log::info!(
            "Clearing CC env from shell: {}, file: {}",
            shell_name,
            env_file_path
        );

        let cleaned = build_cleaned_env_content(&env_file_path);

        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(&env_file_path)
        {
            Ok(_) => {
                std::fs::write(&env_file_path, &cleaned).map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(_) => Err(format!("NEED_PERMISSION:{}", env_file_path)),
        }
    } else {
        // Windows: delete the persistent user env vars from the registry
        let keys = [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        ];
        for key in &keys {
            let _ = std::process::Command::new("reg")
                .args(["delete", "HKCU\\Environment", "/v", key, "/f"])
                .output();
        }
        log::info!("CC env vars removed from Windows registry.");
        Ok(())
    }
}

fn codex_home_dir_from_env_and_home(
    codex_home_env: Option<String>,
    home_dir: Option<PathBuf>,
) -> Result<PathBuf, String> {
    if let Some(codex_home) = codex_home_env.filter(|value| !value.trim().is_empty()) {
        return Ok(PathBuf::from(codex_home));
    }

    if let Some(home_dir) = home_dir {
        return Ok(home_dir.join(".codex"));
    }

    let fallback_home = std::env::var(if cfg!(target_os = "windows") {
        "USERPROFILE"
    } else {
        "HOME"
    })
    .map_err(|_| "Unable to resolve home directory".to_string())?;

    Ok(PathBuf::from(fallback_home).join(".codex"))
}

fn codex_config_path() -> Result<PathBuf, String> {
    let codex_home = codex_home_dir_from_env_and_home(std::env::var("CODEX_HOME").ok(), dirs::home_dir())?;
    Ok(codex_home.join("config.toml"))
}

/// Resolve the config file path: use the caller-supplied override when non-empty,
/// otherwise fall back to the platform default (`~/.codex/config.toml`).
fn resolve_config_path(override_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = override_path.filter(|s| !s.trim().is_empty()) {
        return Ok(PathBuf::from(p));
    }
    codex_config_path()
}

/// Detect the `codex` CLI binary on the system.
/// Searches PATH via `which`/`where`, then checks common install locations.
/// Returns `None` when Codex is not found.
#[tauri::command]
pub fn detect_codex_binary() -> Option<String> {
    // Probe PATH with `which` (Unix) or `where` (Windows).
    #[cfg(not(target_os = "windows"))]
    let probe_cmd = "which";
    #[cfg(target_os = "windows")]
    let probe_cmd = "where";

    if let Ok(output) = std::process::Command::new(probe_cmd).arg("codex").output() {
        if output.status.success() {
            if let Ok(s) = std::str::from_utf8(&output.stdout) {
                // `where` on Windows may return multiple lines — take the first.
                let first = s.lines().next().unwrap_or("").trim();
                if !first.is_empty() {
                    return Some(first.to_string());
                }
            }
        }
    }

    // Fall back to well-known install locations.
    let home = dirs::home_dir()?;
    let mut candidates: Vec<PathBuf> = vec![
        home.join(".local/bin/codex"),
        home.join(".bun/bin/codex"),
        home.join(".npm-global/bin/codex"),
        home.join(".volta/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/usr/bin/codex"),
    ];
    #[cfg(target_os = "macos")]
    candidates.push(PathBuf::from("/opt/homebrew/bin/codex"));
    #[cfg(target_os = "windows")]
    candidates.push(home.join("AppData/Roaming/npm/codex.cmd"));

    for path in &candidates {
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }

    None
}

const CODEX_JAN_PROFILE: &str = "jan";
const CODEX_DEFAULT_MODEL_CONTEXT_WINDOW: i64 = 272_000;
const CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT: i64 = 244_800;

fn codex_provider_table(base_url: &str, api_key: Option<&str>) -> Table {
    let mut provider = Table::new();
    provider["name"] = value("Jan");
    provider["base_url"] = value(base_url.to_string());
    provider["wire_api"] = value("responses");
    provider["request_max_retries"] = value(0);
    provider["stream_max_retries"] = value(0);

    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
        provider["experimental_bearer_token"] = value(key.to_string());
    }

    provider
}

/// Converts a single JSON object (one MCP server entry from Jan) into a TOML table
/// containing only the fields that Codex's `RawMcpServerConfig` accepts.
/// Fields like `env` values, `active`, `official`, and Jan-internal metadata are dropped.
fn json_obj_to_codex_mcp_table(config: &serde_json::Value) -> Option<Table> {
    let obj = config.as_object()?;
    let mut tbl = Table::new();

    if let Some(cmd) = obj.get("command").and_then(|v| v.as_str()) {
        if !cmd.is_empty() {
            tbl["command"] = value(cmd);
        }
    }
    if let Some(args_json) = obj.get("args").and_then(|v| v.as_array()) {
        let mut arr = Array::new();
        for arg in args_json {
            if let Some(s) = arg.as_str() {
                arr.push(s);
            }
        }
        if !arr.is_empty() {
            tbl["args"] = Item::Value(TomlValue::Array(arr));
        }
    }
    if let Some(url) = obj.get("url").and_then(|v| v.as_str()) {
        if !url.is_empty() {
            tbl["url"] = value(url);
        }
    }

    // Only export the entry if it has enough information to be usable
    if tbl.contains_key("command") || tbl.contains_key("url") {
        Some(tbl)
    } else {
        None
    }
}

fn load_codex_document(config_path: &std::path::Path) -> Result<DocumentMut, String> {
    if config_path.exists() {
        let content = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
        if content.trim().is_empty() {
            Ok(DocumentMut::new())
        } else {
            content.parse::<DocumentMut>().map_err(|e| e.to_string())
        }
    } else {
        Ok(DocumentMut::new())
    }
}

#[tauri::command]
pub fn write_codex_config(
    base_url: String,
    api_key: Option<String>,
    model: Option<String>,
    context_window: Option<i64>,
    // Active MCP servers from Jan to forward into Codex's [mcp_servers] table.
    // Keyed by server name; each value is a JSON object with at least `command`/`args`
    // (stdio) or `url` (HTTP). Fields unsupported by Codex (e.g. `env` values,
    // `active`, `official`) are silently ignored.
    mcp_servers: Option<serde_json::Value>,
    // Names of MCP servers written by a previous `write_codex_config` call.
    // These are removed first so stale entries don't accumulate.
    prev_mcp_server_names: Option<Vec<String>>,
    // Optional override path for the config file (None → use platform default).
    config_path_override: Option<String>,
) -> Result<(), String> {
    let config_path = resolve_config_path(config_path_override.as_deref())?;
    let config_dir = config_path
        .parent()
        .ok_or_else(|| "Unable to resolve Codex config directory".to_string())?;

    fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;

    let mut document = load_codex_document(&config_path)?;

    // Always clear stale context window values first, then re-set if we have a valid one.
    document.remove("model_context_window");
    document.remove("model_auto_compact_token_limit");
    if let Some(w) = context_window.filter(|&w| w > 0) {
        document["model_context_window"] = value(w);
        document["model_auto_compact_token_limit"] = value((w * 9) / 10);
    }

    if !document.get("model_providers").map(|v| v.is_table()).unwrap_or(false) {
        document["model_providers"] = Item::Table(Table::new());
    }

    let providers = document["model_providers"]
        .as_table_mut()
        .ok_or_else(|| "Failed to initialize Codex provider table".to_string())?;
    providers[CODEX_JAN_PROFILE] = Item::Table(codex_provider_table(&base_url, api_key.as_deref()));

    if !document.get("profiles").map(|v| v.is_table()).unwrap_or(false) {
        document["profiles"] = Item::Table(Table::new());
    }

    let profiles = document["profiles"]
        .as_table_mut()
        .ok_or_else(|| "Failed to initialize Codex profiles table".to_string())?;

    let mut jan_profile = Table::new();
    jan_profile["model_provider"] = value(CODEX_JAN_PROFILE);
    // Only write the model key when a model is actually selected; an empty string
    // would cause Codex to use "" as the model name and fail.
    if let Some(m) = model.filter(|v| !v.trim().is_empty()) {
        jan_profile["model"] = value(m.clone());
        
        let catalog_path = config_dir.join("jan_model_catalog.json");
        let cw = context_window.unwrap_or(131072);
        let catalog_json = serde_json::json!({
            "models": [{
                "slug": &m,
                "display_name": &m,
                "provider": "jan",
                "priority": 100,
                "visibility": "list",
                "supported_in_api": true,
                "context_window": cw,
                "max_context_window": cw,
                "default_reasoning_level": "medium",
                "supported_reasoning_levels": [
                    {
                        "effort": "low",
                        "description": "Fast responses"
                    },
                    {
                        "effort": "medium",
                        "description": "Balanced reasoning"
                    },
                    {
                        "effort": "high",
                        "description": "Deep reasoning"
                    }
                ],
                "shell_type": "shell_command",
                "base_instructions": "You are a helpful coding assistant.",
                "model_messages": {
                    "instructions_template": "{{ base_instructions }}\n\n{{ personality }}",
                    "instructions_variables": {
                        "base_instructions": "CODEX_CATALOG_BASE_INSTRUCTIONS",
                        "personality": "",
                        "personality_default": "",
                        "personality_friendly": "",
                        "personality_pragmatic": ""
                    }
                },
                "supports_reasoning_summaries": true,
                "default_reasoning_summary": "none",
                "support_verbosity": true,
                "default_verbosity": "low",
                "apply_patch_tool_type": "freeform",
                "web_search_tool_type": "text_and_image",
                "truncation_policy": {
                    "mode": "tokens",
                    "limit": 10000
                },
                "supports_parallel_tool_calls": true,
                "supports_image_detail_original": true,
                "effective_context_window_percent": 95,
                "experimental_supported_tools": [],
                "input_modalities": ["text"],
                "supports_search_tool": true
            }]
        });
        if fs::write(&catalog_path, serde_json::to_string_pretty(&catalog_json).unwrap_or_default()).is_ok() {
            jan_profile["model_catalog_json"] = value(catalog_path.to_string_lossy().into_owned());
        }
    }
    // Sensible defaults for local-model coding sessions.
    jan_profile["approval_policy"] = value("on-request");
    jan_profile["sandbox_mode"] = value("workspace-write");
    profiles[CODEX_JAN_PROFILE] = Item::Table(jan_profile);

    // --- MCP servers ---
    // First remove any servers from the previous save that are no longer active.
    if let Some(prev_names) = prev_mcp_server_names {
        if let Some(mcp_tbl) = document.get_mut("mcp_servers").and_then(|v| v.as_table_mut()) {
            for name in &prev_names {
                mcp_tbl.remove(name.as_str());
            }
            if mcp_tbl.is_empty() {
                document.remove("mcp_servers");
            }
        }
    }
    // Then write the current active servers.
    if let Some(serde_json::Value::Object(servers_map)) = mcp_servers {
        if !servers_map.is_empty() {
            if !document.get("mcp_servers").map(|v| v.is_table()).unwrap_or(false) {
                let mut implicit = Table::new();
                implicit.set_implicit(true);
                document["mcp_servers"] = Item::Table(implicit);
            }
            let mcp_tbl = document["mcp_servers"]
                .as_table_mut()
                .ok_or_else(|| "Failed to initialize mcp_servers table".to_string())?;
            for (name, config) in &servers_map {
                if let Some(server_tbl) = json_obj_to_codex_mcp_table(config) {
                    mcp_tbl[name.as_str()] = Item::Table(server_tbl);
                }
            }
        }
    }

    fs::write(&config_path, document.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn clear_codex_config(
    model: Option<String>,
    // Names of MCP servers that `write_codex_config` added to `[mcp_servers]`.
    // These entries are removed unconditionally when the user resets the integration.
    mcp_server_names: Option<Vec<String>>,
    // Optional override path for the config file (None → use platform default).
    config_path_override: Option<String>,
) -> Result<(), String> {
    let config_path = resolve_config_path(config_path_override.as_deref())?;
    if !config_path.exists() {
        return Ok(());
    }

    let mut document = load_codex_document(&config_path)?;

    if document.get("profile").and_then(|v| v.as_str()) == Some(CODEX_JAN_PROFILE) {
        document.remove("profile");
    }

    if let Some(providers) = document.get_mut("model_providers").and_then(|v| v.as_table_mut()) {
        providers.remove(CODEX_JAN_PROFILE);
        if providers.is_empty() {
            document.remove("model_providers");
        }
    }

    let mut removed_jan_profile = false;
    if let Some(profiles) = document.get_mut("profiles").and_then(|v| v.as_table_mut()) {
        let should_remove = match profiles.get(CODEX_JAN_PROFILE) {
            Some(Item::Table(profile)) => {
                profile.get("model_provider").and_then(|v| v.as_str()) == Some(CODEX_JAN_PROFILE)
                    && match model.as_deref() {
                        Some(selected_model) if !selected_model.trim().is_empty() => {
                            profile.get("model").and_then(|v| v.as_str()) == Some(selected_model)
                        }
                        // Handle both old behavior (model = "") and new behavior (key absent)
                        _ => {
                            let saved_model = profile.get("model").and_then(|v| v.as_str());
                            saved_model.is_none() || saved_model == Some("")
                        }
                    }
            }
            _ => false,
        };

        if should_remove {
            profiles.remove(CODEX_JAN_PROFILE);
            removed_jan_profile = true;
        }

        if profiles.is_empty() {
            document.remove("profiles");
        }
    }

    // Remove context window keys only when Jan's profile was successfully removed,
    // since Jan owns those keys and removing them unconditionally could affect
    // other profiles the user has set up.
    if removed_jan_profile {
        document.remove("model_context_window");
        document.remove("model_auto_compact_token_limit");
    }

    // Remove MCP servers that Jan wrote, regardless of profile match status.
    // The user explicitly clicked Reset, so all Jan-managed entries should be cleaned up.
    if let Some(names) = mcp_server_names {
        if let Some(mcp_tbl) = document.get_mut("mcp_servers").and_then(|v| v.as_table_mut()) {
            for name in &names {
                mcp_tbl.remove(name.as_str());
            }
            if mcp_tbl.is_empty() {
                document.remove("mcp_servers");
            }
        }
    }

    fs::write(&config_path, document.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove the Jan-managed profile from the Codex config unconditionally.
/// Removes [profiles.jan] and [model_providers.jan], and clears the global
/// `profile` key when it points to the Jan profile.
/// This lets the user switch Codex back to standard (non-Jan) behaviour.
#[tauri::command]
pub fn remove_codex_jan_profile(config_path_override: Option<String>) -> Result<(), String> {
    let config_path = resolve_config_path(config_path_override.as_deref())?;
    if !config_path.exists() {
        return Ok(());
    }
    let mut document = load_codex_document(&config_path)?;

    if document.get("profile").and_then(|v| v.as_str()) == Some(CODEX_JAN_PROFILE) {
        document.remove("profile");
    }

    if let Some(providers) = document.get_mut("model_providers").and_then(|v| v.as_table_mut()) {
        providers.remove(CODEX_JAN_PROFILE);
        if providers.is_empty() {
            document.remove("model_providers");
        }
    }

    if let Some(profiles) = document.get_mut("profiles").and_then(|v| v.as_table_mut()) {
        profiles.remove(CODEX_JAN_PROFILE);
        if profiles.is_empty() {
            document.remove("profiles");
        }
    }

    fs::write(&config_path, document.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Read the entire Codex config.toml as a raw string.
/// Returns an empty string when the file does not yet exist.
#[tauri::command]
pub fn read_codex_config_raw(config_path_override: Option<String>) -> Result<String, String> {
    let config_path = resolve_config_path(config_path_override.as_deref())?;
    if !config_path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&config_path).map_err(|e| e.to_string())
}

/// Validate `content` as TOML then overwrite the Codex config.toml with it.
/// The parent directory is created if it does not exist.
#[tauri::command]
pub fn write_codex_config_raw(content: String, config_path_override: Option<String>) -> Result<(), String> {
    // Validate syntax before touching the file.
    content
        .parse::<DocumentMut>()
        .map_err(|e| format!("Invalid TOML: {e}"))?;

    let config_path = resolve_config_path(config_path_override.as_deref())?;
    let config_dir = config_path
        .parent()
        .ok_or_else(|| "Unable to resolve Codex config directory".to_string())?;
    fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    fs::write(&config_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Structured Codex config field access
// ---------------------------------------------------------------------------

/// The known top-level scalar fields from Codex's `config.toml`.
/// All fields are optional — absent keys round-trip as `None`.
#[derive(serde::Serialize, serde::Deserialize, Default, Debug)]
pub struct CodexConfigFields {
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub profile: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub model_context_window: Option<i64>,
    pub model_auto_compact_token_limit: Option<i64>,
    pub approval_policy: Option<String>,
    pub sandbox_mode: Option<String>,
    pub shell: Option<String>,
    pub history_max_context_tokens: Option<i64>,
    pub disable_response_storage: Option<bool>,
    pub notify_on_completion: Option<bool>,
    pub hide_agent_reasoning: Option<bool>,
    pub full_stdout: Option<bool>,
    // [profiles.jan] fields — only populated when that section exists
    pub jan_profile_exists: Option<bool>,
    pub jan_profile_model: Option<String>,
    pub jan_profile_approval_policy: Option<String>,
    pub jan_profile_sandbox_mode: Option<String>,
    pub jan_profile_model_reasoning_effort: Option<String>,
    // [model_providers.jan] fields
    pub jan_provider_base_url: Option<String>,
}

/// Read and return only the known top-level scalar fields from config.toml.
/// Complex tables (profiles, model_providers, mcp_servers) are left out.
#[tauri::command]
pub fn parse_codex_config_fields(config_path_override: Option<String>) -> Result<CodexConfigFields, String> {
    let config_path = resolve_config_path(config_path_override.as_deref())?;
    let doc = load_codex_document(&config_path)?;
    let jan_profile_tbl = doc
        .get("profiles")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("jan"))
        .and_then(|v| v.as_table());
    let jan_provider_tbl = doc
        .get("model_providers")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("jan"))
        .and_then(|v| v.as_table());
    Ok(CodexConfigFields {
        model: doc.get("model").and_then(|v| v.as_str()).map(|s| s.to_string()),
        model_provider: doc.get("model_provider").and_then(|v| v.as_str()).map(|s| s.to_string()),
        profile: doc.get("profile").and_then(|v| v.as_str()).map(|s| s.to_string()),
        model_reasoning_effort: doc.get("model_reasoning_effort").and_then(|v| v.as_str()).map(|s| s.to_string()),
        model_context_window: doc.get("model_context_window").and_then(|v| v.as_integer()),
        model_auto_compact_token_limit: doc.get("model_auto_compact_token_limit").and_then(|v| v.as_integer()),
        approval_policy: doc.get("approval_policy").and_then(|v| v.as_str()).map(|s| s.to_string()),
        sandbox_mode: doc.get("sandbox_mode").and_then(|v| v.as_str()).map(|s| s.to_string()),
        shell: doc.get("shell").and_then(|v| v.as_str()).map(|s| s.to_string()),
        history_max_context_tokens: doc.get("history_max_context_tokens").and_then(|v| v.as_integer()),
        disable_response_storage: doc.get("disable_response_storage").and_then(|v| v.as_bool()),
        notify_on_completion: doc.get("notify_on_completion").and_then(|v| v.as_bool()),
        hide_agent_reasoning: doc.get("hide_agent_reasoning").and_then(|v| v.as_bool()),
        full_stdout: doc.get("full_stdout").and_then(|v| v.as_bool()),
        jan_profile_exists: Some(jan_profile_tbl.is_some()),
        jan_profile_model: jan_profile_tbl.and_then(|t| t.get("model")).and_then(|v| v.as_str()).map(|s| s.to_string()),
        jan_profile_approval_policy: jan_profile_tbl.and_then(|t| t.get("approval_policy")).and_then(|v| v.as_str()).map(|s| s.to_string()),
        jan_profile_sandbox_mode: jan_profile_tbl.and_then(|t| t.get("sandbox_mode")).and_then(|v| v.as_str()).map(|s| s.to_string()),
        jan_profile_model_reasoning_effort: jan_profile_tbl.and_then(|t| t.get("model_reasoning_effort")).and_then(|v| v.as_str()).map(|s| s.to_string()),
        jan_provider_base_url: jan_provider_tbl.and_then(|t| t.get("base_url")).and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}

/// Update only the known scalar fields in config.toml, preserving all other
/// content (complex tables such as profiles, model_providers, mcp_servers).
/// Returns the new raw TOML so callers can keep the raw editor in sync.
#[tauri::command]
pub fn update_codex_config_fields(fields: CodexConfigFields, config_path_override: Option<String>) -> Result<String, String> {
    let config_path = resolve_config_path(config_path_override.as_deref())?;
    let config_dir = config_path
        .parent()
        .ok_or_else(|| "Unable to resolve Codex config directory".to_string())?;
    fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;

    let mut doc = load_codex_document(&config_path)?;

    codex_set_or_remove_str(&mut doc, "model", fields.model.as_deref());
    codex_set_or_remove_str(&mut doc, "model_provider", fields.model_provider.as_deref());
    codex_set_or_remove_str(&mut doc, "profile", fields.profile.as_deref());
    codex_set_or_remove_str(
        &mut doc,
        "model_reasoning_effort",
        fields.model_reasoning_effort.as_deref(),
    );
    codex_set_or_remove_str(&mut doc, "approval_policy", fields.approval_policy.as_deref());
    codex_set_or_remove_str(&mut doc, "sandbox_mode", fields.sandbox_mode.as_deref());
    codex_set_or_remove_str(&mut doc, "shell", fields.shell.as_deref());

    codex_set_or_remove_int(&mut doc, "model_context_window", fields.model_context_window);
    codex_set_or_remove_int(
        &mut doc,
        "model_auto_compact_token_limit",
        fields.model_auto_compact_token_limit,
    );
    codex_set_or_remove_int(
        &mut doc,
        "history_max_context_tokens",
        fields.history_max_context_tokens,
    );

    codex_set_or_remove_bool(
        &mut doc,
        "disable_response_storage",
        fields.disable_response_storage,
    );
    codex_set_or_remove_bool(
        &mut doc,
        "notify_on_completion",
        fields.notify_on_completion,
    );
    codex_set_or_remove_bool(
        &mut doc,
        "hide_agent_reasoning",
        fields.hide_agent_reasoning,
    );
    codex_set_or_remove_bool(&mut doc, "full_stdout", fields.full_stdout);

    // Update [profiles.jan] when it already exists in the document.
    // We never auto-create it here — that is done by write_codex_config (Save & Enable).
    if fields.jan_profile_exists == Some(true) {
        if let Some(jan) = doc
            .get_mut("profiles")
            .and_then(|v| v.as_table_mut())
            .and_then(|t| t.get_mut("jan"))
            .and_then(|v| v.as_table_mut())
        {
            match fields.jan_profile_model.as_deref() {
                Some(s) if !s.is_empty() => { jan["model"] = value(s.to_string()); }
                _ => { jan.remove("model"); }
            }
            match fields.jan_profile_approval_policy.as_deref() {
                Some(s) if !s.is_empty() => { jan["approval_policy"] = value(s.to_string()); }
                _ => { jan.remove("approval_policy"); }
            }
            match fields.jan_profile_sandbox_mode.as_deref() {
                Some(s) if !s.is_empty() => { jan["sandbox_mode"] = value(s.to_string()); }
                _ => { jan.remove("sandbox_mode"); }
            }
            match fields.jan_profile_model_reasoning_effort.as_deref() {
                Some(s) if !s.is_empty() => { jan["model_reasoning_effort"] = value(s.to_string()); }
                _ => { jan.remove("model_reasoning_effort"); }
            }
        }
    }

    // Update [model_providers.jan].base_url when the provider exists.
    if let Some(new_url) = fields.jan_provider_base_url.as_deref().filter(|s| !s.is_empty()) {
        if let Some(jan_prov) = doc
            .get_mut("model_providers")
            .and_then(|v| v.as_table_mut())
            .and_then(|t| t.get_mut("jan"))
            .and_then(|v| v.as_table_mut())
        {
            jan_prov["base_url"] = value(new_url.to_string());
        }
    }

    let updated = doc.to_string();
    fs::write(&config_path, &updated).map_err(|e| e.to_string())?;
    Ok(updated)
}

fn codex_set_or_remove_str(doc: &mut DocumentMut, key: &str, val: Option<&str>) {
    match val {
        Some(s) if !s.is_empty() => {
            doc[key] = value(s.to_string());
        }
        _ => {
            doc.remove(key);
        }
    }
}

fn codex_set_or_remove_int(doc: &mut DocumentMut, key: &str, val: Option<i64>) {
    match val {
        Some(v) => {
            doc[key] = value(v);
        }
        None => {
            doc.remove(key);
        }
    }
}

fn codex_set_or_remove_bool(doc: &mut DocumentMut, key: &str, val: Option<bool>) {
    match val {
        Some(v) => {
            doc[key] = value(v);
        }
        None => {
            doc.remove(key);
        }
    }
}

/// Determine the best writable directory for the Jan CLI install (Unix only).
#[cfg(unix)]
fn jan_cli_install_dir() -> Result<PathBuf, String> {
    let usr_local_bin = PathBuf::from("/usr/local/bin");
    if usr_local_bin.exists() {
        let probe = usr_local_bin.join(".jan_write_probe");
        if std::fs::write(&probe, b"").is_ok() {
            let _ = std::fs::remove_file(&probe);
            return Ok(usr_local_bin);
        }
    }
    let home =
        std::env::var("HOME").map_err(|_| "Cannot determine home directory".to_string())?;
    Ok(PathBuf::from(home).join(".local").join("bin"))
}

/// Return the directory containing the bundled CLI binary on Windows.
#[cfg(windows)]
fn jan_cli_bin_dir_windows() -> Result<PathBuf, String> {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .map_err(|_| "Cannot determine LOCALAPPDATA".to_string())?;
    Ok(PathBuf::from(local_app_data)
        .join("Programs")
        .join("Jan")
        .join("resources")
        .join("bin"))
}

/// Add a directory to the Windows user PATH.
#[cfg(windows)]
fn add_to_path_windows(install_dir: &PathBuf) -> Result<(), String> {
    use std::process::Command;

    let install_dir_str = install_dir.to_string_lossy().to_string();

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path', 'User')",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let read_output = cmd
        .output()
        .map_err(|e| format!("Failed to read user PATH: {}", e))?;

    let existing_user_path = String::from_utf8_lossy(&read_output.stdout)
        .trim()
        .to_string();

    // Remove stale old-style PATH entry (..\\Programs\\Jan without \\resources\\bin)
    // left by previous versions that placed jan.exe next to the GUI binary.
    let old_jan_dir = install_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().to_string());

    let parts: Vec<&str> = existing_user_path
        .split(';')
        .filter(|p| !p.is_empty())
        .filter(|p| {
            if let Some(ref old) = old_jan_dir {
                !p.eq_ignore_ascii_case(old)
            } else {
                true
            }
        })
        .collect();

    if parts.iter().any(|p| p.eq_ignore_ascii_case(&install_dir_str)) {
        return Ok(());
    }

    let mut new_parts = vec![install_dir_str.as_str()];
    new_parts.extend(parts);
    let new_path = new_parts.join(";");

    let mut cmd_write = Command::new("powershell");
    cmd_write.args([
        "-NoProfile",
        "-Command",
        &format!(
            "[Environment]::SetEnvironmentVariable('Path', '{}', 'User')",
            new_path.replace('\'', "''")
        ),
    ]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd_write.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let write_output = cmd_write
        .output()
        .map_err(|e| format!("Failed to update user PATH: {}", e))?;

    if !write_output.status.success() {
        return Err(format!(
            "Failed to update PATH: {}",
            String::from_utf8_lossy(&write_output.stderr)
        ));
    }

    log::info!("Added {} to Windows user PATH", install_dir_str);
    Ok(())
}

/// Remove a directory from the Windows user PATH.
#[cfg(windows)]
fn remove_from_path_windows(dir: &PathBuf) -> Result<(), String> {
    use std::process::Command;

    let dir_str = dir.to_string_lossy().to_string();

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path', 'User')",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let read_output = cmd
        .output()
        .map_err(|e| format!("Failed to read user PATH: {}", e))?;

    let existing_user_path = String::from_utf8_lossy(&read_output.stdout)
        .trim()
        .to_string();

    let new_path: String = existing_user_path
        .split(';')
        .filter(|p| !p.is_empty() && !p.eq_ignore_ascii_case(&dir_str))
        .collect::<Vec<_>>()
        .join(";");

    if new_path.len() != existing_user_path.len() {
        let mut cmd_write = Command::new("powershell");
        cmd_write.args([
            "-NoProfile",
            "-Command",
            &format!(
                "[Environment]::SetEnvironmentVariable('Path', '{}', 'User')",
                new_path.replace('\'', "''")
            ),
        ]);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd_write.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let write_output = cmd_write
            .output()
            .map_err(|e| format!("Failed to update user PATH: {}", e))?;

        if !write_output.status.success() {
            return Err(format!(
                "Failed to update PATH: {}",
                String::from_utf8_lossy(&write_output.stderr)
            ));
        }

        log::info!("Removed {} from Windows user PATH", dir_str);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::app::constants::*;
    use std::fs;
    use tempfile::tempdir;
    use toml_edit::DocumentMut;

    fn create_all_data(dir: &std::path::Path) {
        for subdir in JAN_DATA_SUBDIRS {
            fs::create_dir_all(dir.join(subdir)).unwrap();
            fs::write(dir.join(subdir).join("dummy.txt"), "data").unwrap();
        }
        for file in JAN_DATA_FILES {
            fs::write(dir.join(file), "data").unwrap();
        }
    }

    fn exists_any(dir: &std::path::Path, names: &[&str]) -> bool {
        names.iter().any(|n| dir.join(n).exists())
    }

    fn exists_all(dir: &std::path::Path, names: &[&str]) -> bool {
        names.iter().all(|n| dir.join(n).exists())
    }

    #[test]
    fn test_codex_profile_config_is_written() {
        let mut document = DocumentMut::new();
        document["model_context_window"] = value(CODEX_DEFAULT_MODEL_CONTEXT_WINDOW);
        document["model_auto_compact_token_limit"] = value(CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT);
        document["model_providers"] = Item::Table(Table::new());
        document["profiles"] = Item::Table(Table::new());

        let providers = document["model_providers"].as_table_mut().unwrap();
        providers[CODEX_JAN_PROFILE] = Item::Table(codex_provider_table(
            "http://127.0.0.1:1337/v1",
            Some("secret"),
        ));

        let profiles = document["profiles"].as_table_mut().unwrap();
        let mut jan_profile = Table::new();
        jan_profile["model_provider"] = value(CODEX_JAN_PROFILE);
        jan_profile["model"] = value("jan-pro");
        profiles[CODEX_JAN_PROFILE] = Item::Table(jan_profile);

        let output = document.to_string();

        assert!(output.contains("model_context_window = 272000"));
        assert!(output.contains("model_auto_compact_token_limit = 244800"));
        assert!(output.contains("[model_providers.jan]"));
        assert!(output.contains("base_url = \"http://127.0.0.1:1337/v1\""));
        assert!(output.contains("experimental_bearer_token = \"secret\""));
        assert!(output.contains("[profiles.jan]"));
        assert!(output.contains("model_provider = \"jan\""));
        assert!(output.contains("model = \"jan-pro\""));
    }

    #[test]
    fn test_codex_home_dir_prefers_codex_home_env() {
        let path = codex_home_dir_from_env_and_home(
            Some(r"C:\Users\alice\Codex Home".to_string()),
            Some(PathBuf::from("/ignored-home")),
        )
        .unwrap();

        assert_eq!(path, PathBuf::from(r"C:\Users\alice\Codex Home"));
    }

    #[test]
    fn test_delete_conversations_only_removes_conversation_dirs() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_conversations(d);

        assert!(!exists_any(d, JAN_DATA_DIRS_CONVERSATIONS));
        assert!(exists_all(d, JAN_DATA_DIRS_MODELS));
        assert!(exists_all(d, JAN_DATA_DIRS_COMMON));
        assert!(d.join("settings.json").exists());
        assert!(d.join("mcp_config.json").exists());
    }

    #[test]
    fn test_delete_models_and_configs_only_removes_model_dirs_and_config_files() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_models_and_configs(d);

        assert!(!exists_any(d, JAN_DATA_DIRS_MODELS));
        assert!(!exists_any(d, JAN_DATA_FILES_CONFIGS));
        assert!(exists_all(d, JAN_DATA_DIRS_CONVERSATIONS));
        assert!(exists_all(d, JAN_DATA_DIRS_COMMON));
        assert!(d.join("settings.json").exists());
    }

    #[test]
    fn test_delete_common_data_only_removes_common_dirs() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_common_data(d);

        assert!(!exists_any(d, JAN_DATA_DIRS_COMMON));
        assert!(exists_all(d, JAN_DATA_DIRS_CONVERSATIONS));
        assert!(exists_all(d, JAN_DATA_DIRS_MODELS));
        assert!(d.join("settings.json").exists());
        assert!(d.join("mcp_config.json").exists());
    }

    #[test]
    fn test_delete_settings_only_removes_settings_json() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_settings(d);

        assert!(!d.join("settings.json").exists());
        assert!(exists_all(d, JAN_DATA_DIRS_CONVERSATIONS));
        assert!(exists_all(d, JAN_DATA_DIRS_MODELS));
        assert!(exists_all(d, JAN_DATA_DIRS_COMMON));
        assert!(d.join("mcp_config.json").exists());
    }

    #[test]
    fn test_settings_json_survives_when_keeping_any_category() {
        // Simulate: keep_app_data=true, keep_models_and_configs=false
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_common_data(d);
        delete_models_and_configs(d);
        // settings.json should NOT be deleted because keep_app_data=true
        assert!(d.join("settings.json").exists());

        // Simulate: keep_app_data=false, keep_models_and_configs=true
        let tmp2 = tempdir().unwrap();
        let d2 = tmp2.path();
        create_all_data(d2);

        delete_common_data(d2);
        delete_conversations(d2);
        // settings.json should NOT be deleted because keep_models_and_configs=true
        assert!(d2.join("settings.json").exists());
    }

    #[test]
    fn test_full_wipe_deletes_settings_json() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        create_all_data(d);

        delete_common_data(d);
        delete_conversations(d);
        delete_models_and_configs(d);
        delete_settings(d);

        assert!(!d.join("settings.json").exists());
        assert!(!exists_any(d, JAN_DATA_SUBDIRS));
        assert!(!exists_any(d, JAN_DATA_FILES));
    }

    #[test]
    fn test_delete_on_nonexistent_dirs_does_not_panic() {
        let tmp = tempdir().unwrap();
        let d = tmp.path();
        // Nothing created — should not panic
        delete_conversations(d);
        delete_models_and_configs(d);
        delete_common_data(d);
        delete_settings(d);
    }

    #[test]
    fn test_is_safe_to_delete() {
        assert!(!is_safe_to_delete(std::path::Path::new("/")));
        assert!(!is_safe_to_delete(std::path::Path::new("/home")));
        assert!(is_safe_to_delete(std::path::Path::new("/home/user/jan")));
        assert!(is_safe_to_delete(std::path::Path::new(
            "/home/user/.local/share/jan"
        )));
    }
}
