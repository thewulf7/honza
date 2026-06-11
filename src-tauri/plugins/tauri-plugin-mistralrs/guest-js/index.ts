import { invoke } from '@tauri-apps/api/core'
import { SessionInfo, UnloadResult, MistralrsConfig } from './types'

export { SessionInfo, UnloadResult, MistralrsConfig } from './types'

function asNumber(v: any, defaultValue = 0): number {
  if (v === '' || v === null || v === undefined) return defaultValue
  const n = Number(v)
  return isFinite(n) ? n : defaultValue
}

function asString(v: any, defaultValue = ''): string {
  if (v === null || v === undefined) return defaultValue
  return String(v)
}

function asBool(v: any, defaultValue = false): boolean {
  if (v === null || v === undefined) return defaultValue
  return Boolean(v)
}

export function normalizeMistralrsConfig(config: any): MistralrsConfig {
  return {
    ctx_size: asNumber(config.ctx_size),
    dtype: asString(config.dtype, 'auto'),
    max_seqs: asNumber(config.max_seqs, 16),
    num_device_layers: asString(config.num_device_layers, ''),
    no_kv_cache: asBool(config.no_kv_cache, false),
    in_situ_quant: asString(config.in_situ_quant, 'none'),
    tok_model_id: asString(config.tok_model_id, ''),
    force_cpu: asBool(config.force_cpu, false),
    prefix_cache_n: asNumber(config.prefix_cache_n, 16),
  }
}

export async function loadMistralrsModel(
  modelId: string,
  modelPath: string,
  port: number,
  cfg: MistralrsConfig,
  envs: Record<string, string>,
  isEmbedding: boolean = false,
  timeout: number = 600
): Promise<SessionInfo> {
  const config = normalizeMistralrsConfig(cfg)
  return await invoke('plugin:mistralrs|load_mistralrs_model', {
    modelId,
    modelPath,
    port,
    config,
    envs,
    isEmbedding,
    timeout,
  })
}

export async function unloadMistralrsModel(pid: number): Promise<UnloadResult> {
  return await invoke('plugin:mistralrs|unload_mistralrs_model', { pid })
}

export async function isMistralrsProcessRunning(pid: number): Promise<boolean> {
  return await invoke('plugin:mistralrs|is_mistralrs_process_running', { pid })
}

export async function getMistralrsRandomPort(): Promise<number> {
  return await invoke('plugin:mistralrs|get_mistralrs_random_port')
}

export async function findMistralrsSessionByModel(
  modelId: string
): Promise<SessionInfo | null> {
  return await invoke('plugin:mistralrs|find_mistralrs_session_by_model', {
    modelId,
  })
}

export async function getMistralrsLoadedModels(): Promise<string[]> {
  return await invoke('plugin:mistralrs|get_mistralrs_loaded_models')
}

export async function getMistralrsAllSessions(): Promise<SessionInfo[]> {
  return await invoke('plugin:mistralrs|get_mistralrs_all_sessions')
}

