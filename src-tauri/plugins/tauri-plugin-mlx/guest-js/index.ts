import { invoke } from '@tauri-apps/api/core'
import { SessionInfo, UnloadResult, MlxConfig } from './types'

export { SessionInfo, UnloadResult, MlxConfig } from './types'

function asNumber(v: any, defaultValue = 0): number {
  if (v === '' || v === null || v === undefined) return defaultValue
  const n = Number(v)
  return isFinite(n) ? n : defaultValue
}

export function normalizeMlxConfig(config: any): MlxConfig {
  const normalized: MlxConfig = {
    ctx_size: asNumber(config.ctx_size),
  }
  if (config.kv_bits != null) normalized.kv_bits = asNumber(config.kv_bits)
  if (config.max_kv_size != null) normalized.max_kv_size = asNumber(config.max_kv_size)
  if (config.prefill_step_size != null) normalized.prefill_step_size = asNumber(config.prefill_step_size, 512)
  if (config.memory_limit_gb != null) normalized.memory_limit_gb = asNumber(config.memory_limit_gb)
  return normalized
}

export async function loadMlxModel(
  modelId: string,
  modelPath: string,
  port: number,
  cfg: MlxConfig,
  envs: Record<string, string>,
  isEmbedding: boolean = false,
  timeout: number = 600
): Promise<SessionInfo> {
  const config = normalizeMlxConfig(cfg)
  return await invoke('plugin:mlx|load_mlx_model', {
    modelId,
    modelPath,
    port,
    config,
    envs,
    isEmbedding,
    timeout,
  })
}

export async function unloadMlxModel(pid: number): Promise<UnloadResult> {
  return await invoke('plugin:mlx|unload_mlx_model', { pid })
}

export async function isMlxProcessRunning(pid: number): Promise<boolean> {
  return await invoke('plugin:mlx|is_mlx_process_running', { pid })
}

export async function getMlxRandomPort(): Promise<number> {
  return await invoke('plugin:mlx|get_mlx_random_port')
}

export async function findMlxSessionByModel(
  modelId: string
): Promise<SessionInfo | null> {
  return await invoke('plugin:mlx|find_mlx_session_by_model', { modelId })
}

export async function getMlxLoadedModels(): Promise<string[]> {
  return await invoke('plugin:mlx|get_mlx_loaded_models')
}

export async function getMlxAllSessions(): Promise<SessionInfo[]> {
  return await invoke('plugin:mlx|get_mlx_all_sessions')
}

/** Override the mlx-server binary used for loading models.
 *  Pass an empty string to revert to the bundled binary. */
export async function setMlxCustomBinaryPath(path: string): Promise<void> {
  return await invoke('plugin:mlx|set_mlx_custom_binary_path', { path })
}

/** Return the binary path that will be resolved when loading models.
 *  Returns the custom override if set and present on disk, otherwise the bundled path. */
export async function getMlxResolvedBinaryPath(): Promise<string> {
  return await invoke('plugin:mlx|get_mlx_resolved_binary_path')
}
