import { joinPath, fs } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { readGgufMetadata } from '@janhq/tauri-plugin-llamacpp-api'
import { getSystemInfo, getSystemUsage } from '@janhq/tauri-plugin-hardware-api'
import type { ModelConfig } from '@janhq/tauri-plugin-llamacpp-api'

export type SuggestionSeverity = 'improvement' | 'warning' | 'info'

export interface ConfigSuggestion {
  /** Key to write directly into model.yml. */
  yamlKey: string
  displayName: string
  currentValue: string | number | boolean | null
  suggestedValue: string | number | boolean | null
  reason: string
  severity: SuggestionSeverity
  /** false = info-only, no Apply button shown. */
  canApply: boolean
}

export interface ConfigAnalysis {
  modelId: string
  hardware: {
    gpus: Array<{ name: string; vramMB: number }>
    cpuName: string
    cpuCores: number
    totalRamMB: number
    primaryVramMB: number
    hasGpu: boolean
  }
  model: {
    arch: string
    quantName: string
    nLayers: number
    trainedCtxLen: number
    fileSizeMB: number
  }
  currentConfig: {
    n_gpu_layers: number | null
    flash_attn: string | null
    cache_type_k: string
    cache_type_v: string
    ctx_size: number
    cont_batching: boolean
  }
  suggestions: ConfigSuggestion[]
  routerPort: number | null
  routerApiKey: string | null
}

// GGUF general.file_type integer → quant name
const GGUF_QUANT_NAMES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1',
  8: 'Q8_0', 10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L',
  14: 'Q4_K_S', 15: 'Q4_K_M', 16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K',
  19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'IQ3_XXS', 29: 'BF16',
}

function isQuantizedFileType(fileType: number): boolean {
  // F32 = 0, F16 = 1, BF16 = 29 are full precision; everything else is quantized
  return fileType !== 0 && fileType !== 1 && fileType !== 29
}

function parseMeta(meta: Record<string, string>, arch: string, key: string): number {
  const raw = meta[`${arch}.${key}`] ?? meta[key] ?? ''
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

type ModelYamlFull = ModelConfig & {
  n_gpu_layers?: number
  flash_attn?: string
  cache_type_k?: string
  cache_type_v?: string
  ctx_size?: number
  cont_batching?: boolean
}

export interface GlobalProviderConfig {
  flash_attn: string    // 'on' | 'off' | '' (auto)
  cache_type_k: string  // 'f16' | 'q8_0' | ...
  cache_type_v: string
  cont_batching: boolean
  threads: number
}

export async function analyzeModelConfig(
  modelId: string,
  providerPath: string,
  janDataFolderPath: string,
  global: GlobalProviderConfig,
  routerInfo: { port: number; apiKey: string } | null
): Promise<ConfigAnalysis | null> {
  try {
    // ── 1. Read model.yml ──────────────────────────────────────────────────
    const modelDir = await joinPath([providerPath, 'models', modelId])
    const ymlPath = await joinPath([modelDir, 'model.yml'])
    if (!(await fs.existsSync(ymlPath))) return null

    const mc = (await invoke<ModelYamlFull>('read_yaml', { path: ymlPath }))

    // ── 2. Resolve GGUF file path ──────────────────────────────────────────
    let ggufPath: string
    if (mc.model_path) {
      const isAbsolute =
        mc.model_path.startsWith('/') ||
        mc.model_path.startsWith('\\') ||
        /^[A-Za-z]:[\\/]/.test(mc.model_path)
      ggufPath = isAbsolute
        ? mc.model_path
        : await joinPath([janDataFolderPath, mc.model_path])
    } else {
      ggufPath = await joinPath([modelDir, 'model.gguf'])
    }

    if (!(await fs.existsSync(ggufPath))) return null

    // ── 3. Read GGUF metadata ──────────────────────────────────────────────
    const gguf = await readGgufMetadata(ggufPath)
    const meta = gguf.metadata ?? {}
    const arch = (meta['general.architecture'] ?? 'llama') as string
    const fileType = Number(meta['general.file_type'] ?? '1') || 1
    const nLayers = parseMeta(meta, arch, 'block_count')
    const nHeadsQ = parseMeta(meta, arch, 'attention.head_count') || 32
    const nHeadsKV = parseMeta(meta, arch, 'attention.head_count_kv') || nHeadsQ
    const embeddingLength = parseMeta(meta, arch, 'embedding_length') || 4096
    const trainedCtxLen = parseMeta(meta, arch, 'context_length')
    const fileSizeMB = mc.size_bytes ? Math.round(mc.size_bytes / (1024 * 1024)) : 0

    // ── 4. Get hardware ────────────────────────────────────────────────────
    const [sysInfo, sysUsage] = await Promise.all([
      getSystemInfo(),
      getSystemUsage().catch(() => null),
    ])

    const gpus = sysInfo.gpus.map((g) => ({
      name: g.name,
      vramMB: Math.round(g.total_memory),
      usedMB: (() => {
        const u = sysUsage?.gpus.find((x) => x.uuid === g.uuid)
        return u ? Math.round(u.used_memory) : 0
      })(),
    }))
    const primaryGpu = gpus[0] ?? null
    const primaryVramMB = primaryGpu?.vramMB ?? 0
    const hasGpu = gpus.length > 0 && primaryVramMB > 0

    // ── 5. Effective current settings (per-model takes priority over global) ─
    // flash_attn: per-model model.yml value, else fall back to global provider
    const perModelFlashAttn: string | null =
      typeof mc.flash_attn === 'string' && mc.flash_attn.length > 0
        ? mc.flash_attn
        : null
    const effectiveFlashAttn = perModelFlashAttn ?? global.flash_attn ?? ''

    const perModelCacheK =
      typeof mc.cache_type_k === 'string' && mc.cache_type_k.length > 0
        ? mc.cache_type_k
        : null
    const effectiveCacheK = perModelCacheK ?? global.cache_type_k ?? 'f16'

    const perModelCacheV =
      typeof mc.cache_type_v === 'string' && mc.cache_type_v.length > 0
        ? mc.cache_type_v
        : null
    const effectiveCacheV = perModelCacheV ?? global.cache_type_v ?? 'f16'

    const currentNgl =
      typeof mc.n_gpu_layers === 'number' ? mc.n_gpu_layers : null
    const currentCtxSize = mc.ctx_size ?? 8192
    const currentContBatching = mc.cont_batching ?? true  // llama.cpp default is on

    // ── 6. Apply rules ─────────────────────────────────────────────────────
    const suggestions: ConfigSuggestion[] = []

    // Rule 1 — GPU layers
    if (hasGpu && fileSizeMB > 0) {
      const headroom = 0.90  // keep 10% VRAM margin for KV cache / OS
      const usableVramMB = primaryVramMB * headroom

      const modelFitsInVram = fileSizeMB <= usableVramMB
      const currentLayers = currentNgl ?? 0
      const allLayersOnGpu = nLayers > 0
        ? currentLayers >= nLayers
        : currentLayers >= 99   // unknown layer count fallback

      if (modelFitsInVram && !allLayersOnGpu) {
        const suggestedNgl = nLayers > 0 ? nLayers : 999
        suggestions.push({
          yamlKey: 'n_gpu_layers',
          displayName: 'GPU Layers',
          currentValue: currentNgl,
          suggestedValue: suggestedNgl,
          reason: `Model (${fileSizeMB}MB) fits in VRAM (${primaryVramMB}MB). Setting to ${nLayers > 0 ? nLayers : 'all'} layers maximises GPU throughput.`,
          severity: 'improvement',
          canApply: true,
        })
      } else if (!modelFitsInVram && currentLayers === 0) {
        // Model doesn't fully fit but GPU exists and user is on CPU — suggest partial
        if (nLayers > 0) {
          const suggestedLayers = Math.max(1, Math.floor((usableVramMB / fileSizeMB) * nLayers))
          suggestions.push({
            yamlKey: 'n_gpu_layers',
            displayName: 'GPU Layers',
            currentValue: 0,
            suggestedValue: suggestedLayers,
            reason: `Model (${fileSizeMB}MB) exceeds VRAM (${primaryVramMB}MB) but ~${suggestedLayers}/${nLayers} layers can be offloaded for a hybrid speed gain.`,
            severity: 'improvement',
            canApply: true,
          })
        }
      }
    } else if (!hasGpu && currentNgl !== null && currentNgl > 0) {
      suggestions.push({
        yamlKey: 'n_gpu_layers',
        displayName: 'GPU Layers',
        currentValue: currentNgl,
        suggestedValue: 0,
        reason: 'No GPU detected. Setting GPU layers to 0 avoids startup errors.',
        severity: 'warning',
        canApply: true,
      })
    }

    // Rule 2 — Flash attention
    // Suggest enabling if: GPU present, not already explicitly 'on', and not a pure embedding model
    if (hasGpu && effectiveFlashAttn !== 'on') {
      suggestions.push({
        yamlKey: 'flash_attn',
        displayName: 'Flash Attention',
        currentValue: effectiveFlashAttn === 'off' ? 'off' : 'auto',
        suggestedValue: 'on',
        reason: 'Flash attention reduces KV cache VRAM usage and speeds up long-context inference. Free win on any modern GPU.',
        severity: 'improvement',
        canApply: true,
      })
    }

    // Rule 3 — KV cache quantization
    if (isQuantizedFileType(fileType)) {
      const quantName = GGUF_QUANT_NAMES[fileType] ?? `type_${fileType}`
      const headDim = embeddingLength / Math.max(nHeadsQ, 1)
      const kvCacheMbF16 = Math.round(
        (currentCtxSize * (nLayers || 32) * nHeadsKV * headDim * 2 * 2) / (1024 * 1024)
      )
      const savings = Math.round(kvCacheMbF16 * 0.5)

      if (effectiveCacheK === 'f16' || effectiveCacheK === '') {
        suggestions.push({
          yamlKey: 'cache_type_k',
          displayName: 'KV Cache Type (K)',
          currentValue: effectiveCacheK || 'f16',
          suggestedValue: 'q8_0',
          reason: `${quantName} model: q8_0 KV cache saves ~${savings}MB at ctx=${currentCtxSize.toLocaleString()} with negligible quality loss.`,
          severity: 'improvement',
          canApply: true,
        })
      }
      if (effectiveCacheV === 'f16' || effectiveCacheV === '') {
        suggestions.push({
          yamlKey: 'cache_type_v',
          displayName: 'KV Cache Type (V)',
          currentValue: effectiveCacheV || 'f16',
          suggestedValue: 'q8_0',
          reason: `Same as K: q8_0 halves V-cache VRAM with minimal impact on output quality.`,
          severity: 'improvement',
          canApply: true,
        })
      }
    }

    // Rule 4 — Context length info (no apply, just awareness)
    if (trainedCtxLen > 0 && currentCtxSize < trainedCtxLen) {
      const ratio = trainedCtxLen / currentCtxSize
      if (ratio >= 4) {
        suggestions.push({
          yamlKey: 'ctx_size',
          displayName: 'Context Length',
          currentValue: currentCtxSize,
          suggestedValue: null,
          reason: `This model supports up to ${trainedCtxLen.toLocaleString()} tokens. You can increase Context Size to handle longer conversations (requires more VRAM).`,
          severity: 'info',
          canApply: false,
        })
      }
    }

    // Rule 5 — CPU threads (info only, it's a provider-level setting)
    if (!hasGpu || currentNgl === 0) {
      const physicalCores = sysInfo.cpu.core_count
      if (global.threads > 0 && global.threads !== physicalCores) {
        suggestions.push({
          yamlKey: 'threads',
          displayName: 'CPU Threads',
          currentValue: global.threads,
          suggestedValue: physicalCores,
          reason: `For CPU inference, matching thread count to physical cores (${physicalCores}) typically gives best throughput. Set in the provider's global settings.`,
          severity: 'info',
          canApply: false,
        })
      }
    }

    return {
      modelId,
      hardware: {
        gpus: gpus.map(({ name, vramMB }) => ({ name, vramMB })),
        cpuName: sysInfo.cpu.name,
        cpuCores: sysInfo.cpu.core_count,
        totalRamMB: Math.round(sysInfo.total_memory),
        primaryVramMB,
        hasGpu,
      },
      model: {
        arch,
        quantName: GGUF_QUANT_NAMES[fileType] ?? `type_${fileType}`,
        nLayers,
        trainedCtxLen,
        fileSizeMB,
      },
      currentConfig: {
        n_gpu_layers: currentNgl,
        flash_attn: perModelFlashAttn,
        cache_type_k: effectiveCacheK,
        cache_type_v: effectiveCacheV,
        ctx_size: currentCtxSize,
        cont_batching: currentContBatching,
      },
      suggestions,
      routerPort: routerInfo?.port ?? null,
      routerApiKey: routerInfo?.apiKey ?? null,
    }
  } catch (e) {
    console.error('analyzeModelConfig failed:', e)
    return null
  }
}

/**
 * Writes a set of yamlKey → value patches directly to model.yml.
 * Callers must restart the router afterward.
 */
export async function patchModelYaml(
  modelId: string,
  providerPath: string,
  patch: Record<string, string | number | boolean | null>
): Promise<boolean> {
  try {
    const configPath = await joinPath([providerPath, 'models', modelId, 'model.yml'])
    if (!(await fs.existsSync(configPath))) return false

    const cfg = (await invoke<Record<string, unknown>>('read_yaml', { path: configPath }))

    let touched = false
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        if (key in cfg) {
          delete cfg[key]
          touched = true
        }
      } else if (cfg[key] !== value) {
        cfg[key] = value
        touched = true
      }
    }

    if (!touched) return false
    await invoke<void>('write_yaml', { data: cfg, savePath: configPath })
    return true
  } catch (e) {
    console.error('patchModelYaml failed:', e)
    return false
  }
}
