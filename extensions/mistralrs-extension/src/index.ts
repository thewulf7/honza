import {
  AIEngine,
  AppEvent,
  DownloadEvent,
  ImportOptions,
  SessionInfo,
  UnloadResult,
  chatCompletion,
  chatCompletionChunk,
  chatCompletionRequest,
  events,
  fs,
  getJanDataFolderPath,
  joinPath,
  modelInfo,
} from '@janhq/core'

import { invoke } from '@tauri-apps/api/core'
import { error as logErr, info as logInfo, warn as logWarn } from '@tauri-apps/plugin-log'

import {
  MistralrsConfig,
  findMistralrsSessionByModel,
  getMistralrsLoadedModels,
  getMistralrsRandomPort,
  isMistralrsProcessRunning,
  loadMistralrsModel,
  unloadMistralrsModel,
} from '@janhq/tauri-plugin-mistralrs-api'

import { OUT_OF_CONTEXT_SIZE, appendToBuffer, parseSseLine } from './sse'
import {
  MistralrsBackend,
  buildDropdownOptions,
  determineBestBackend,
  determineSupportedBackends,
  downloadBackend,
  fetchRemoteBackends,
  getBackendExePath,
  installFromArchive,
  isBackendInstalled,
  listAvailableBackends,
} from './backends'

const logger = {
  info: (...args: any[]) => {
    console.log(...args)
    logInfo(args.map(String).join(' '))
  },
  warn: (...args: any[]) => {
    console.warn(...args)
    logWarn(args.map(String).join(' '))
  },
  error: (...args: any[]) => {
    console.error(...args)
    logErr(args.map(String).join(' '))
  },
}

/** On-disk model manifest (model.yml), shared with the llamacpp provider. */
interface ModelManifest {
  name?: string
  model_path: string
  size_bytes?: number
  embedding?: boolean
}

const isAbsolute = (p: string) => p.startsWith('/') || p.includes(':')

const isValidModelId = (id: string) => {
  if (!/^[a-zA-Z0-9/_\-.]+$/.test(id)) return false
  return id.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
}

export default class MistralrsExtension extends AIEngine {
  readonly provider: string = 'mistralrs'
  readonly providerId: string = 'mistralrs'
  autoUnload: boolean = true
  timeout: number = 600

  private config: Record<string, any> = {}
  private loadingModels = new Map<string, Promise<SessionInfo>>()
  private configuringBackends: Promise<void> | null = null

  // -------------------------------------------------------------------------
  // Lifecycle & settings
  // -------------------------------------------------------------------------

  override async onLoad(): Promise<void> {
    super.onLoad()

    const settings = structuredClone(SETTINGS)
    this.registerSettings(settings)

    for (const item of settings) {
      this.config[item.key] = await this.getSetting<any>(
        item.key,
        item.controllerProps.value
      )
    }

    this.autoUnload = this.config.auto_unload ?? true
    this.timeout = Number(this.config.timeout ?? 600)

    // Fill the version/backend dropdown, pick a recommendation and install /
    // auto-update the selected backend. Runs in the background so app
    // startup never blocks on the network.
    this.configureBackends().catch((e) =>
      logger.error('mistral.rs backend configuration failed:', e)
    )
  }

  override async onUnload(): Promise<void> {
    // Server processes are owned by the Tauri plugin and cleaned up on exit.
  }

  onSettingUpdate<T>(key: string, value: T): void {
    // core's updateSettings re-fires this hook for every persisted setting,
    // including untouched ones (extension.ts forEach). Only react to actual
    // changes, or persistBackendOptions' own writes would loop back here and
    // hammer the GitHub API.
    const changed = this.config[key] !== value
    this.config[key] = value
    if (!changed) return

    switch (key) {
      case 'auto_unload':
        this.autoUnload = Boolean(value)
        break
      case 'timeout':
        this.timeout = Number(value)
        break
      case 'version_backend': {
        const selection = String(value ?? '')
        if (selection.includes('/')) {
          this.ensureBackendReady(selection).catch((e) =>
            logger.error(`Failed to install backend ${selection}:`, e)
          )
        }
        break
      }
      case 'release_repo':
        this.refreshBackendOptions().catch((e) =>
          logger.error('Failed to refresh backend options:', e)
        )
        break
      // Everything else is read from this.config at the next model load.
    }
  }

  private getReleaseRepo(): string {
    const repo = String(this.config.release_repo ?? '').trim()
    return repo || GITHUB_REPO
  }

  // -------------------------------------------------------------------------
  // Model catalog (manifests shared with the llamacpp provider so GGUF
  // downloads from the Hub are usable by both engines without duplication)
  // -------------------------------------------------------------------------

  private async modelsDir(): Promise<string> {
    return joinPath([await getJanDataFolderPath(), 'llamacpp', 'models'])
  }

  private async manifestPath(modelId: string): Promise<string> {
    return joinPath([await this.modelsDir(), modelId, 'model.yml'])
  }

  private async readManifest(modelId: string): Promise<ModelManifest> {
    return invoke<ModelManifest>('read_yaml', {
      path: await this.manifestPath(modelId),
    })
  }

  /** Absolute path of the model weights file referenced by a manifest. */
  private async resolveModelFile(manifest: ModelManifest): Promise<string> {
    if (isAbsolute(manifest.model_path)) return manifest.model_path
    return joinPath([await getJanDataFolderPath(), manifest.model_path])
  }

  private toModelInfo(modelId: string, manifest: ModelManifest): modelInfo {
    return {
      id: modelId,
      name: manifest.name ?? modelId,
      providerId: this.provider,
      port: 0,
      sizeBytes: manifest.size_bytes ?? 0,
      embedding: manifest.embedding ?? false,
    } as modelInfo
  }

  override async get(modelId: string): Promise<modelInfo | undefined> {
    if (!(await fs.existsSync(await this.manifestPath(modelId))))
      return undefined
    return this.toModelInfo(modelId, await this.readManifest(modelId))
  }

  override async list(): Promise<modelInfo[]> {
    const modelsDir = await this.modelsDir()
    if (!(await fs.existsSync(modelsDir))) {
      await fs.mkdir(modelsDir)
      return []
    }

    // Model IDs may contain slashes (e.g. "author/model"), so walk the tree
    // and treat every directory holding a model.yml as one model.
    const modelIds: string[] = []
    const pending: string[] = [modelsDir]
    while (pending.length > 0) {
      const dir = pending.pop()!
      if (await fs.existsSync(await joinPath([dir, 'model.yml']))) {
        modelIds.push(dir.slice(modelsDir.length + 1))
        continue
      }
      for (const child of await fs.readdirSync(dir)) {
        const stat = await fs.fileStat(child)
        if (stat.isDirectory) pending.push(child)
      }
    }

    const result: modelInfo[] = []
    for (const modelId of modelIds) {
      try {
        result.push(this.toModelInfo(modelId, await this.readManifest(modelId)))
      } catch (e) {
        logger.warn(`Skipping unreadable model manifest for ${modelId}:`, e)
      }
    }
    return result
  }

  override async delete(modelId: string): Promise<void> {
    const modelDir = await joinPath([await this.modelsDir(), modelId])
    if (!(await fs.existsSync(await joinPath([modelDir, 'model.yml'])))) {
      throw new Error(`Model ${modelId} does not exist`)
    }

    const manifest = await this.readManifest(modelId)

    // Remove the weights only when they live inside Jan's data folder; an
    // absolute model_path means the user imported an external file we must
    // not touch.
    if (!isAbsolute(manifest.model_path)) {
      const weightsFile = await this.resolveModelFile(manifest)
      const weightsDir = weightsFile.substring(0, weightsFile.lastIndexOf('/'))
      if (weightsDir !== modelDir && (await fs.existsSync(weightsDir))) {
        await fs.rm(weightsDir)
      }
    }

    await fs.rm(modelDir)
  }

  override async update(
    modelId: string,
    model: Partial<modelInfo>
  ): Promise<void> {
    const newId = model.id
    if (!newId || newId === modelId) return
    if (!isValidModelId(newId)) {
      throw new Error(`Invalid model ID: ${newId}`)
    }

    const modelsDir = await this.modelsDir()
    const oldDir = await joinPath([modelsDir, modelId])
    const newDir = await joinPath([modelsDir, newId])
    if (await fs.existsSync(newDir)) {
      throw new Error(`Model with ID ${newId} already exists`)
    }

    const manifest = await this.readManifest(modelId)
    await fs.mv(oldDir, newDir)
    await invoke('write_yaml', {
      data: {
        ...manifest,
        model_path: manifest.model_path?.replace(
          `llamacpp/models/${modelId}`,
          `llamacpp/models/${newId}`
        ),
      },
      savePath: await joinPath([newDir, 'model.yml']),
    })
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  private downloadTaskId(modelId: string): string {
    const cleanId = modelId.includes('.')
      ? modelId.slice(0, modelId.indexOf('.'))
      : modelId
    return `${this.provider}/${cleanId}`
  }

  private downloadManager() {
    return window.core.extensionManager.getByName('@janhq/download-extension')
  }

  override async import(modelId: string, opts: ImportOptions): Promise<void> {
    if (!isValidModelId(modelId)) {
      throw new Error(
        `Invalid modelId: ${modelId}. Only alphanumeric and / _ - . characters are allowed.`
      )
    }
    if (await fs.existsSync(await this.manifestPath(modelId))) {
      throw new Error(`Model ${modelId} already exists`)
    }

    if (opts.modelPath.startsWith('https://')) {
      await this.importFromUrl(modelId, opts)
    } else {
      await this.importFromLocalFile(modelId, opts.modelPath)
    }
  }

  private async importFromUrl(
    modelId: string,
    opts: ImportOptions
  ): Promise<void> {
    const modelDir = await joinPath([await this.modelsDir(), modelId])
    const filename = opts.modelPath.split('/').pop() || 'model.gguf'
    const savePath = await joinPath([modelDir, filename])

    const items = [
      { url: opts.modelPath, save_path: savePath, model_id: modelId },
      ...(opts.files ?? []).map((f) => ({
        url: f.url,
        save_path: f.filename, // resolved below
        model_id: modelId,
      })),
    ]
    // Resolve extra-file save paths (joinPath is async, so done in a loop).
    for (let i = 1; i < items.length; i++) {
      items[i].save_path = await joinPath([modelDir, items[i].save_path])
    }

    const downloadType = 'Model'
    try {
      await this.downloadManager().downloadFiles(
        items,
        this.downloadTaskId(modelId),
        (transferred: number, total: number) => {
          events.emit(DownloadEvent.onFileDownloadUpdate, {
            modelId,
            percent: transferred / total,
            size: { transferred, total },
            downloadType,
          })
        }
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('cancelled') || message.includes('aborted')) {
        logger.info('Download stopped for model:', modelId)
        events.emit(DownloadEvent.onFileDownloadStopped, {
          modelId,
          downloadType,
        })
        return
      }
      logger.error('Error downloading model:', modelId, message)
      events.emit(DownloadEvent.onFileDownloadError, {
        modelId,
        downloadType,
        error: message,
      })
      throw err
    }

    const manifest: ModelManifest = {
      name: modelId,
      model_path: `llamacpp/models/${modelId}/${filename}`,
      size_bytes: opts.modelSize ?? 0,
    }
    await fs.mkdir(modelDir)
    await invoke('write_yaml', {
      data: manifest,
      savePath: await this.manifestPath(modelId),
    })

    events.emit(AppEvent.onModelImported, {
      modelId,
      modelPath: manifest.model_path,
      size_bytes: manifest.size_bytes,
    })
    events.emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
      modelId,
      downloadType,
    })
  }

  private async importFromLocalFile(
    modelId: string,
    sourcePath: string
  ): Promise<void> {
    if (!(await fs.existsSync(sourcePath))) {
      throw new Error(`File not found: ${sourcePath}`)
    }

    const stat = await fs.fileStat(sourcePath)
    const manifest: ModelManifest = {
      name: modelId,
      model_path: sourcePath,
      size_bytes: stat.size,
    }

    const modelDir = await joinPath([await this.modelsDir(), modelId])
    await fs.mkdir(modelDir)
    await invoke('write_yaml', {
      data: manifest,
      savePath: await this.manifestPath(modelId),
    })

    events.emit(AppEvent.onModelImported, {
      modelId,
      modelPath: sourcePath,
      size_bytes: stat.size,
    })
  }

  override async abortImport(modelId: string): Promise<void> {
    try {
      await this.downloadManager().cancelDownload(this.downloadTaskId(modelId))
    } catch (e) {
      logger.warn('Failed to cancel download task:', e)
    }

    const modelDir = await joinPath([await this.modelsDir(), modelId])
    if (await fs.existsSync(modelDir)) {
      await fs.rm(modelDir).catch((e: unknown) => {
        logger.warn('Failed to clean up model directory:', e)
      })
    }
  }

  override async pauseImport(modelId: string): Promise<void> {
    await this.downloadManager().pauseDownload(this.downloadTaskId(modelId))
  }

  // -------------------------------------------------------------------------
  // Load / unload
  // -------------------------------------------------------------------------

  override async load(
    modelId: string,
    overrideSettings?: any,
    isEmbedding: boolean = false,
    bypassAutoUnload: boolean = false
  ): Promise<SessionInfo> {
    if (await findMistralrsSessionByModel(modelId)) {
      throw new Error('Model already loaded!')
    }

    const inFlight = this.loadingModels.get(modelId)
    if (inFlight) return inFlight

    const loading = this.performLoad(
      modelId,
      overrideSettings,
      isEmbedding,
      bypassAutoUnload
    )
    this.loadingModels.set(modelId, loading)
    try {
      return await loading
    } finally {
      this.loadingModels.delete(modelId)
    }
  }

  private async performLoad(
    modelId: string,
    overrideSettings?: any,
    isEmbedding: boolean = false,
    bypassAutoUnload: boolean = false
  ): Promise<SessionInfo> {
    if (this.autoUnload && !isEmbedding && !bypassAutoUnload) {
      // Wait for concurrent loads, then evict everything that is running.
      const others = Array.from(this.loadingModels.entries())
        .filter(([id]) => id !== modelId)
        .map(([, p]) => p.catch(() => undefined))
      if (others.length > 0) await Promise.all(others)

      const loaded = await this.getLoadedModels()
      if (loaded.length > 0) {
        await Promise.all(loaded.map((id) => this.unload(id)))
      }
    }

    const cfg = { ...this.config, ...(overrideSettings ?? {}) }
    const manifest = await this.readManifest(modelId)
    const modelPath = await this.resolveModelFile(manifest)
    const backendPath = await this.resolveBackendExePath()
    const port = await getMistralrsRandomPort()

    const serverConfig: MistralrsConfig = {
      ctx_size: cfg.ctx_size ?? 4096,
      dtype: cfg.dtype ?? 'auto',
      max_seqs: cfg.max_seqs ?? 16,
      max_batch_size: cfg.max_batch_size ?? 0,
      num_device_layers: cfg.num_device_layers ?? '',
      no_kv_cache: cfg.no_kv_cache ?? false,
      in_situ_quant: cfg.in_situ_quant ?? 'none',
      tok_model_id: cfg.tok_model_id ?? '',
      force_cpu: cfg.force_cpu ?? false,
      prefix_cache_n: cfg.prefix_cache_n ?? 16,
      seed: cfg.seed ?? -1,
      paged_attn: cfg.paged_attn ?? false,
      no_paged_attn: cfg.no_paged_attn ?? false,
      paged_attn_gpu_mem: cfg.paged_attn_gpu_mem ?? 0,
      paged_attn_gpu_mem_usage: cfg.paged_attn_gpu_mem_usage ?? 0,
      paged_ctxt_len: cfg.paged_ctxt_len ?? 0,
      paged_attn_block_size: cfg.paged_attn_block_size ?? 0,
      paged_cache_type: cfg.paged_cache_type ?? 'auto',
      chat_template: cfg.chat_template ?? '',
      jinja_explicit: cfg.jinja_explicit ?? '',
      token_source: cfg.token_source ?? '',
    }

    logger.info(
      `Loading mistral.rs model ${modelId} on port ${port} with backend ${backendPath}`
    )

    // mistralrs-server is loopback-only and has no auth; no envs needed yet.
    return loadMistralrsModel(
      backendPath,
      modelId,
      modelPath,
      port,
      serverConfig,
      {},
      isEmbedding,
      this.timeout
    )
  }

  override async unload(modelId: string): Promise<UnloadResult> {
    const session = await findMistralrsSessionByModel(modelId)
    if (!session) {
      throw new Error(`No active mistral.rs session found for model: ${modelId}`)
    }

    try {
      const result = await unloadMistralrsModel(session.pid)
      if (!result.success) {
        logger.warn(`Failed to unload mistral.rs model: ${result.error}`)
      }
      return result
    } catch (e) {
      logger.error('Error unloading mistral.rs model:', e)
      return { success: false, error: `Failed to unload model: ${e}` }
    }
  }

  override async getLoadedModels(): Promise<string[]> {
    return getMistralrsLoadedModels()
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  override async chat(
    opts: chatCompletionRequest,
    abortController?: AbortController
  ): Promise<chatCompletion | AsyncIterable<chatCompletionChunk>> {
    const session = await findMistralrsSessionByModel(opts.model)
    if (!session) {
      throw new Error(
        `No active mistral.rs session found for model: ${opts.model}`
      )
    }

    if (!(await isMistralrsProcessRunning(session.pid))) {
      throw new Error('mistral.rs model has crashed! Please reload!')
    }
    try {
      await fetch(`http://127.0.0.1:${session.port}/health`)
    } catch {
      await this.unload(session.model_id).catch(() => undefined)
      throw new Error('mistral.rs model appears to have crashed! Please reload!')
    }

    const url = `http://127.0.0.1:${session.port}/v1/chat/completions`
    const headers = { 'Content-Type': 'application/json' }
    // mistralrs-server rejects model names other than its model path or
    // "default"; the session serves exactly one model, so "default" it is.
    const body = JSON.stringify({ ...opts, model: 'default' })

    if (opts.stream) {
      return this.streamChat(url, headers, body, abortController)
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: abortController?.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(
        `mistral.rs request failed with status ${response.status}: ${detail}`
      )
    }

    const completion = (await response.json()) as chatCompletion
    if (completion.choices?.[0]?.finish_reason === 'length') {
      throw new Error(OUT_OF_CONTEXT_SIZE)
    }
    return completion
  }

  private async *streamChat(
    url: string,
    headers: Record<string, string>,
    body: string,
    abortController?: AbortController
  ): AsyncIterable<chatCompletionChunk> {
    // One controller covers both the caller's abort signal and the overall
    // streaming timeout (covering the whole response, not just connect).
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error('Request timed out')),
      this.timeout * 1000
    )
    if (abortController?.signal.aborted) {
      controller.abort(abortController.signal.reason)
    } else {
      abortController?.signal.addEventListener(
        'abort',
        () => controller.abort(abortController.signal.reason),
        { once: true }
      )
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(
          `mistral.rs request failed with status ${response.status}: ${detail}`
        )
      }
      if (!response.body) {
        throw new Error('Response body is null')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      try {
        for (;;) {
          const { done, value } = await reader.read()
          const text = done
            ? decoder.decode()
            : decoder.decode(value, { stream: true })

          const [lines, rest] = appendToBuffer(buffer, text)
          buffer = rest
          for (const line of lines) {
            const chunk = parseSseLine(line)
            if (chunk) yield chunk as chatCompletionChunk
          }

          if (done) {
            // Flush a trailing line that arrived without a final newline.
            const tail = parseSseLine(buffer.trim())
            if (tail) yield tail as chatCompletionChunk
            break
          }
        }
      } finally {
        reader.releaseLock()
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // -------------------------------------------------------------------------
  // Tool support
  // -------------------------------------------------------------------------

  /**
   * Tool support is read from the GGUF chat template, same heuristic as the
   * llamacpp provider (whose plugin hosts the GGUF metadata reader).
   */
  async isToolSupported(modelId: string): Promise<boolean> {
    try {
      const manifest = await this.readManifest(modelId)
      const gguf = await invoke<any>('plugin:llamacpp|read_gguf_metadata', {
        path: await this.resolveModelFile(manifest),
      })
      return Boolean(
        gguf?.metadata?.['tokenizer.chat_template']?.includes('tools')
      )
    } catch (e) {
      logger.warn(`isToolSupported failed for ${modelId}:`, e)
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Backend (mistralrs-server binary) management
  // -------------------------------------------------------------------------

  /**
   * Resolves the mistralrs-server executable for the selected
   * version/backend, downloading it first when missing.
   */
  private async resolveBackendExePath(): Promise<string> {
    let selection = String(this.config.version_backend ?? '')

    if (!selection.includes('/')) {
      // Fresh install, or configureBackends hasn't finished / was offline.
      await this.configureBackends()
      selection = String(this.config.version_backend ?? '')
      if (!selection.includes('/')) {
        throw new Error(
          'No mistral.rs backend selected. Open Settings → mistral.rs and pick an Engine Version, or check your network connection.'
        )
      }
    }

    await this.ensureBackendReady(selection)
    const [version, backend] = selection.split('/')
    return getBackendExePath(version, backend)
  }

  /** Downloads the `<version>/<backend>` build if it is not installed yet. */
  private async ensureBackendReady(selection: string): Promise<void> {
    const [version, backend] = selection.split('/')
    if (!version || !backend) {
      throw new Error(`Invalid backend selection: ${selection}`)
    }
    if (await isBackendInstalled(version, backend)) return

    const repo = this.getReleaseRepo()
    const supported = await determineSupportedBackends()
    const remote = await fetchRemoteBackends(repo, supported)
    const match = remote.find(
      (b) => b.version === version && b.backend === backend
    )
    if (!match) {
      throw new Error(
        `Backend ${selection} is not installed and no matching release asset was found in ${repo}`
      )
    }

    logger.info(`Installing mistral.rs backend ${selection} from ${repo}`)
    await downloadBackend(version, backend, match.downloadUrl)
    await this.refreshBackendOptions()
  }

  /**
   * Populates the version/backend dropdown from GitHub releases + local
   * installs, picks a recommendation for fresh installs, installs the
   * selection when missing and runs auto-update when enabled.
   *
   * Concurrent callers (e.g. a model load racing app startup) share the
   * in-flight run instead of skipping past it.
   */
  async configureBackends(): Promise<void> {
    if (this.configuringBackends) {
      return this.configuringBackends
    }
    this.configuringBackends = this.doConfigureBackends().finally(() => {
      this.configuringBackends = null
    })
    return this.configuringBackends
  }

  private async doConfigureBackends(): Promise<void> {
    const repo = this.getReleaseRepo()
    const backends = await listAvailableBackends(repo)
    const best = await determineBestBackend(repo).catch(() => '')

    let selection = String(this.config.version_backend ?? '')
    const isValid =
      selection.includes('/') &&
      backends.some((b) => `${b.version}/${b.backend}` === selection)

    if (!isValid) {
      selection = best
      if (best) {
        logger.info(`No valid backend selected, using recommended: ${best}`)
      }
    }

    // Offline / no releases published: fall back to anything already on
    // disk (sideloaded or downloaded earlier) instead of staying unselected.
    if (!selection && backends.length > 0) {
      const installed = backends.find((b) => b.installed)
      if (installed) {
        selection = `${installed.version}/${installed.backend}`
        logger.info(`No remote recommendation, using installed: ${selection}`)
      }
    }

    await this.persistBackendOptions(backends, selection, best)

    if (selection) {
      try {
        await this.ensureBackendReady(selection)
      } catch (e) {
        logger.warn('Initial backend install failed (will retry on load):', e)
      }
    }

    if (
      this.config.auto_update_engine &&
      best &&
      selection &&
      best !== selection
    ) {
      const [, currentVariant] = selection.split('/')
      const [, bestVariant] = best.split('/')
      // Only auto-move between versions of the same variant; never switch
      // the user between e.g. cuda and cpu builds silently.
      if (currentVariant === bestVariant) {
        logger.info(`Auto-updating mistral.rs backend ${selection} → ${best}`)
        try {
          await this.updateBackend(best)
        } catch (e) {
          logger.warn('Backend auto-update failed:', e)
        }
      }
    }
  }

  /**
   * Refreshes the dropdown options without download/auto-update side
   * effects. Used after sideload installs and release_repo changes.
   */
  async refreshBackendOptions(): Promise<void> {
    try {
      const repo = this.getReleaseRepo()
      const backends = await listAvailableBackends(repo)
      const best = await determineBestBackend(repo).catch(() => '')
      const selection = String(this.config.version_backend ?? '')
      await this.persistBackendOptions(backends, selection, best)
    } catch (e) {
      logger.error('refreshBackendOptions error:', e)
    }
  }

  /** Writes dropdown options / value / recommendation to stored settings. */
  private async persistBackendOptions(
    backends: MistralrsBackend[],
    selection: string,
    recommended: string
  ): Promise<void> {
    // Sync config first so the onSettingUpdate echo from updateSettings sees
    // no change and doesn't re-trigger backend installation.
    this.config.version_backend = selection

    const settings = await this.getSettings()
    await this.updateSettings(
      settings.map((item) => {
        if (item.key === 'version_backend') {
          const props = item.controllerProps as any
          props.options = buildDropdownOptions(backends, selection)
          props.value = selection
          props.recommended = recommended
        }
        return item
      })
    )
  }

  async checkBackendForUpdates(): Promise<{
    updateNeeded: boolean
    newVersion: string
    currentVersion?: string
    targetBackend?: string
  }> {
    try {
      const current = String(this.config.version_backend ?? '')
      const [currentVersion, currentVariant] = current.split('/')
      const repo = this.getReleaseRepo()
      const supported = await determineSupportedBackends()
      const remote = await fetchRemoteBackends(repo, supported)
      if (remote.length === 0) {
        return {
          updateNeeded: false,
          newVersion: currentVersion ?? 'none',
          currentVersion,
        }
      }

      const newestVersion = remote
        .map((b) => b.version)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
      // Prefer the user's current variant when the newest release has it.
      const target =
        remote.find(
          (b) => b.version === newestVersion && b.backend === currentVariant
        ) ?? remote.find((b) => b.version === newestVersion)!

      const updateNeeded = !currentVersion || currentVersion !== newestVersion
      return {
        updateNeeded,
        newVersion: newestVersion,
        currentVersion,
        targetBackend: updateNeeded
          ? `${target.version}/${target.backend}`
          : undefined,
      }
    } catch (e) {
      logger.warn('Failed to check mistral.rs backend updates:', e)
      return { updateNeeded: false, newVersion: 'unknown' }
    }
  }

  /**
   * Invoked by the UI's "Update Now" action with the `<version>/<backend>`
   * string previously returned by checkBackendForUpdates.
   */
  async updateBackend(
    target: string
  ): Promise<{ wasUpdated: boolean; newBackend: string }> {
    const [version, backend] = target.split('/')
    if (!version || !backend) {
      logger.error(`Invalid target backend: "${target}"`)
      return { wasUpdated: false, newBackend: target }
    }

    await this.ensureBackendReady(target)

    const repo = this.getReleaseRepo()
    const backends = await listAvailableBackends(repo)
    const best = await determineBestBackend(repo).catch(() => '')
    await this.persistBackendOptions(backends, target, best)

    logger.info(`mistral.rs backend updated to ${target}`)
    return { wasUpdated: true, newBackend: target }
  }

  /** Install a backend from a local .tar.gz archive (sideload). */
  async installBackend(archivePath: string): Promise<void> {
    const { version, backend } = await installFromArchive(archivePath)
    const selection = `${version}/${backend}`

    const repo = this.getReleaseRepo()
    const backends = await listAvailableBackends(repo)
    const best = await determineBestBackend(repo).catch(() => '')
    await this.persistBackendOptions(backends, selection, best)

    logger.info(`Installed mistral.rs backend from archive: ${selection}`)
  }
}
