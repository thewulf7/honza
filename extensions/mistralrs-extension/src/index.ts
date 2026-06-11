import {
  AIEngine,
  getJanDataFolderPath,
  fs,
  joinPath,
  modelInfo,
  SessionInfo,
  UnloadResult,
  chatCompletion,
  chatCompletionChunk,
  ImportOptions,
  chatCompletionRequest,
  events,
  AppEvent,
  DownloadEvent,
} from '@janhq/core'

import { info, warn, error as logError } from '@tauri-apps/plugin-log'
import { invoke } from '@tauri-apps/api/core'
import {
  loadMistralrsModel,
  unloadMistralrsModel,
  MistralrsConfig,
} from '@janhq/tauri-plugin-mistralrs-api'

import { OUT_OF_CONTEXT_SIZE, appendToBuffer, parseSseLine } from './sse'

const logger = {
  info: function (...args: any[]) {
    console.log(...args)
    info(args.map((arg) => ` ${arg}`).join(` `))
  },
  warn: function (...args: any[]) {
    console.warn(...args)
    warn(args.map((arg) => ` ${arg}`).join(` `))
  },
  error: function (...args: any[]) {
    console.error(...args)
    logError(args.map((arg) => ` ${arg}`).join(` `))
  },
}

export default class mistralrs_extension extends AIEngine {
  provider: string = 'mistralrs'
  autoUnload: boolean = true
  timeout: number = 600
  readonly providerId: string = 'mistralrs'

  private config: any = {}
  private providerPath!: string
  private apiSecret: string = 'JanMistralrs'
  private loadingModels = new Map<string, Promise<SessionInfo>>()

  override async onLoad(): Promise<void> {
    super.onLoad()

    let settings = structuredClone(SETTINGS)
    this.registerSettings(settings)

    let loadedConfig: any = {}
    for (const item of settings) {
      const defaultValue = item.controllerProps.value
      loadedConfig[item.key] = await this.getSetting<typeof defaultValue>(
        item.key,
        defaultValue
      )
    }
    this.config = loadedConfig

    this.autoUnload = this.config.auto_unload ?? true
    this.timeout = this.config.timeout ?? 600

    this.getProviderPath()
  }

  async getProviderPath(): Promise<string> {
    if (!this.providerPath) {
      // Share the llamacpp model directory so GGUF models downloaded from Hub
      // are immediately available without re-downloading.
      this.providerPath = await joinPath([
        await getJanDataFolderPath(),
        'llamacpp',
      ])
    }
    return this.providerPath
  }

  override async onUnload(): Promise<void> {
    // Cleanup handled by Tauri plugin on app exit
  }

  onSettingUpdate<T>(key: string, value: T): void {
    this.config[key] = value

    if (key === 'auto_unload') {
      this.autoUnload = value as boolean
    } else if (key === 'timeout') {
      this.timeout = value as number
    }
    // All other keys (ctx_size, dtype, max_seqs, etc.) are picked up from
    // this.config on the next load — no extra caching needed.
  }

  private async generateApiKey(modelId: string, port: string): Promise<string> {
    // Reuse the llamacpp plugin's API key generation
    const hash = await invoke<string>('plugin:llamacpp|generate_api_key', {
      modelId: modelId + port,
      apiSecret: this.apiSecret,
    })
    return hash
  }

  override async get(modelId: string): Promise<modelInfo | undefined> {
    const modelPath = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
    ])
    const path = await joinPath([modelPath, 'model.yml'])

    if (!(await fs.existsSync(path))) return undefined

    const modelConfig = await invoke<ModelConfig>('read_yaml', { path })

    return {
      id: modelId,
      name: modelConfig.name ?? modelId,
      providerId: this.provider,
      port: 0,
      sizeBytes: modelConfig.size_bytes ?? 0,
      embedding: modelConfig.embedding ?? false,
    } as modelInfo
  }

  override async list(): Promise<modelInfo[]> {
    const modelsDir = await joinPath([await this.getProviderPath(), 'models'])
    if (!(await fs.existsSync(modelsDir))) {
      await fs.mkdir(modelsDir)
    }

    let modelIds: string[] = []

    // DFS to find all model.yml files
    let stack = [modelsDir]
    while (stack.length > 0) {
      const currentDir = stack.pop()!

      const modelConfigPath = await joinPath([currentDir, 'model.yml'])
      if (await fs.existsSync(modelConfigPath)) {
        modelIds.push(currentDir.slice(modelsDir.length + 1))
        continue
      }

      const children = await fs.readdirSync(currentDir)
      for (const child of children) {
        const dirInfo = await fs.fileStat(child)
        if (!dirInfo.isDirectory) continue
        stack.push(child)
      }
    }

    let modelInfos: modelInfo[] = []
    for (const modelId of modelIds) {
      const path = await joinPath([modelsDir, modelId, 'model.yml'])
      const modelConfig = await invoke<ModelConfig>('read_yaml', { path })

      modelInfos.push({
        id: modelId,
        name: modelConfig.name ?? modelId,
        providerId: this.provider,
        port: 0,
        sizeBytes: modelConfig.size_bytes ?? 0,
        embedding: modelConfig.embedding ?? false,
      } as modelInfo)
    }

    return modelInfos
  }

  private async getRandomPort(): Promise<number> {
    try {
      return await invoke<number>('plugin:mistralrs|get_mistralrs_random_port')
    } catch {
      logger.error('Unable to find a suitable port for mistral.rs server')
      throw new Error('Unable to find a suitable port for mistral.rs model')
    }
  }

  override async load(
    modelId: string,
    overrideSettings?: any,
    isEmbedding: boolean = false,
    bypassAutoUnload: boolean = false
  ): Promise<SessionInfo> {
    const sInfo = await this.findSessionByModel(modelId)
    if (sInfo) {
      throw new Error('Model already loaded!')
    }

    if (this.loadingModels.has(modelId)) {
      return this.loadingModels.get(modelId)!
    }

    const loadingPromise = this.performLoad(
      modelId,
      overrideSettings,
      isEmbedding,
      bypassAutoUnload
    )
    this.loadingModels.set(modelId, loadingPromise)

    try {
      return await loadingPromise
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
    const loadedModels = await this.getLoadedModels()

    const otherLoadingPromises = Array.from(this.loadingModels.entries())
      .filter(([id, _]) => id !== modelId)
      .map(([_, promise]) => promise)

    if (
      this.autoUnload &&
      !isEmbedding &&
      !bypassAutoUnload &&
      (loadedModels.length > 0 || otherLoadingPromises.length > 0)
    ) {
      if (otherLoadingPromises.length > 0) {
        await Promise.all(otherLoadingPromises)
      }

      const allLoadedModels = await this.getLoadedModels()
      if (allLoadedModels.length > 0) {
        await Promise.all(allLoadedModels.map((id) => this.unload(id)))
      }
    }

    const cfg = { ...this.config, ...(overrideSettings ?? {}) }

    const janDataFolderPath = await getJanDataFolderPath()
    const modelConfigPath = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
      'model.yml',
    ])
    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path: modelConfigPath,
    })
    const port = await this.getRandomPort()

    const api_key = await this.generateApiKey(modelId, String(port))
    const envs: Record<string, string> = {
      MISTRALRS_API_KEY: api_key,
    }

    // Resolve model path - could be absolute or relative
    let modelPath: string
    if (
      modelConfig.model_path.startsWith('/') ||
      modelConfig.model_path.includes(':')
    ) {
      modelPath = modelConfig.model_path
    } else {
      modelPath = await joinPath([janDataFolderPath, modelConfig.model_path])
    }

    const mistralrsConfig: MistralrsConfig = {
      ctx_size: cfg.ctx_size ?? 4096,
      dtype: cfg.dtype ?? 'auto',
      max_seqs: cfg.max_seqs ?? 16,
      num_device_layers: cfg.num_device_layers ?? '',
      no_kv_cache: cfg.no_kv_cache ?? false,
      in_situ_quant: cfg.in_situ_quant ?? 'none',
      tok_model_id: cfg.tok_model_id ?? '',
      force_cpu: cfg.force_cpu ?? false,
      prefix_cache_n: cfg.prefix_cache_n ?? 16,
    }

    logger.info(
      'Loading mistral.rs model:',
      modelId,
      'with config:',
      JSON.stringify(mistralrsConfig)
    )

    try {
      const sInfo = await loadMistralrsModel(
        modelId,
        modelPath,
        port,
        mistralrsConfig,
        envs,
        isEmbedding,
        Number(this.timeout)
      )
      return sInfo
    } catch (error) {
      logger.error(`Error loading mistral.rs model: ${JSON.stringify(error)}`)
      throw error
    }
  }

  override async unload(modelId: string): Promise<UnloadResult> {
    const sInfo = await this.findSessionByModel(modelId)
    if (!sInfo) {
      throw new Error(
        `No active mistral.rs session found for model: ${modelId}`
      )
    }

    try {
      const result = await unloadMistralrsModel(sInfo.pid)
      if (result.success) {
        logger.info(
          `Successfully unloaded mistral.rs model with PID ${sInfo.pid}`
        )
      } else {
        logger.warn(`Failed to unload mistral.rs model: ${result.error}`)
      }
      return result
    } catch (error) {
      logger.error('Error unloading mistral.rs model:', error)
      return {
        success: false,
        error: `Failed to unload model: ${error}`,
      }
    }
  }

  private async findSessionByModel(modelId: string): Promise<SessionInfo> {
    try {
      return await invoke<SessionInfo>(
        'plugin:mistralrs|find_mistralrs_session_by_model',
        { modelId }
      )
    } catch (e) {
      logger.error(e)
      throw new Error(String(e))
    }
  }

  override async chat(
    opts: chatCompletionRequest,
    abortController?: AbortController
  ): Promise<chatCompletion | AsyncIterable<chatCompletionChunk>> {
    const sessionInfo = await this.findSessionByModel(opts.model)
    if (!sessionInfo) {
      throw new Error(
        `No active mistral.rs session found for model: ${opts.model}`
      )
    }

    const isAlive = await invoke<boolean>(
      'plugin:mistralrs|is_mistralrs_process_running',
      { pid: sessionInfo.pid }
    )

    if (isAlive) {
      try {
        await fetch(`http://127.0.0.1:${sessionInfo.port}/health`)
      } catch (e) {
        this.unload(sessionInfo.model_id)
        throw new Error('mistral.rs model appears to have crashed! Please reload!')
      }
    } else {
      throw new Error('mistral.rs model has crashed! Please reload!')
    }

    const baseUrl = `http://127.0.0.1:${sessionInfo.port}/v1`
    const url = `${baseUrl}/chat/completions`
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionInfo.api_key}`,
    }

    const body = JSON.stringify(opts)

    if (opts.stream) {
      return this.handleStreamingResponse(url, headers, body, abortController)
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: abortController?.signal,
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => null)
      throw new Error(
        `mistral.rs API request failed with status ${response.status}: ${JSON.stringify(errorData)}`
      )
    }

    const completionResponse = (await response.json()) as chatCompletion

    if (completionResponse.choices?.[0]?.finish_reason === 'length') {
      throw new Error(OUT_OF_CONTEXT_SIZE)
    }

    return completionResponse
  }

  private async *handleStreamingResponse(
    url: string,
    headers: HeadersInit,
    body: string,
    abortController?: AbortController
  ): AsyncIterable<chatCompletionChunk> {
    const combinedController = new AbortController()
    // Timeout covers the entire streaming duration, not just connection establishment.
    const timeoutId = setTimeout(
      () => combinedController.abort(new Error('Request timed out')),
      this.timeout * 1000
    )
    if (abortController?.signal) {
      if (abortController.signal.aborted) {
        combinedController.abort(abortController.signal.reason)
      } else {
        abortController.signal.addEventListener(
          'abort',
          () => combinedController.abort(abortController.signal.reason),
          { once: true }
        )
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: combinedController.signal,
    })

    if (!response.ok) {
      clearTimeout(timeoutId)
      const errorData = await response.json().catch(() => null)
      throw new Error(
        `mistral.rs API request failed with status ${response.status}: ${JSON.stringify(errorData)}`
      )
    }

    if (!response.body) {
      clearTimeout(timeoutId)
      throw new Error('Response body is null')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          // Flush decoder state and process any trailing content
          const flushed = decoder.decode()
          if (flushed) {
            const [trailingLines] = appendToBuffer(buffer, flushed)
            for (const line of trailingLines) {
              const chunk = parseSseLine(line)
              if (chunk) yield chunk as chatCompletionChunk
            }
          }
          break
        }

        const decoded = decoder.decode(value, { stream: true })
        const [lines, newBuffer] = appendToBuffer(buffer, decoded)
        buffer = newBuffer

        for (const line of lines) {
          let chunk
          try {
            chunk = parseSseLine(line)
          } catch (e) {
            if (e instanceof SyntaxError) {
              logger.error('Error parsing mistral.rs stream JSON:', e)
            }
            throw e
          }
          if (chunk) yield chunk as chatCompletionChunk
        }
      }
    } finally {
      clearTimeout(timeoutId)
      reader.releaseLock()
    }
  }

  override async delete(modelId: string): Promise<void> {
    const modelDir = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
    ])

    const modelConfigPath = await joinPath([modelDir, 'model.yml'])
    if (!(await fs.existsSync(modelConfigPath))) {
      throw new Error(`Model ${modelId} does not exist`)
    }

    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path: modelConfigPath,
    })

    // Delete the model file if it's stored at a relative path within mistralrs folder
    if (
      !modelConfig.model_path.startsWith('/') &&
      !modelConfig.model_path.includes(':')
    ) {
      const janDataFolderPath = await getJanDataFolderPath()
      const modelPath = await joinPath([
        janDataFolderPath,
        modelConfig.model_path,
      ])
      const parentDir = modelPath.substring(0, modelPath.lastIndexOf('/'))
      if (parentDir !== modelDir) {
        await fs.rm(parentDir)
      }
    }

    await fs.rm(modelDir)
  }

  override async update(
    modelId: string,
    model: Partial<modelInfo>
  ): Promise<void> {
    const modelFolderPath = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
    ])
    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path: await joinPath([modelFolderPath, 'model.yml']),
    })
    const newFolderPath = await joinPath([
      await this.getProviderPath(),
      'models',
      model.id,
    ])
    if (await fs.existsSync(newFolderPath)) {
      throw new Error(`Model with ID ${model.id} already exists`)
    }
    const newModelConfigPath = await joinPath([newFolderPath, 'model.yml'])
    await fs.mv(modelFolderPath, newFolderPath).then(() =>
      invoke('write_yaml', {
        data: {
          ...modelConfig,
          model_path: modelConfig?.model_path?.replace(
            `llamacpp/models/${modelId}`,
            `llamacpp/models/${model.id}`
          ),
        },
        savePath: newModelConfigPath,
      })
    )
  }

  override async import(modelId: string, opts: ImportOptions): Promise<void> {
    const isValidModelId = (id: string) => {
      if (!/^[a-zA-Z0-9/_\-\.]+$/.test(id)) return false
      const parts = id.split('/')
      return parts.every((s) => s !== '' && s !== '.' && s !== '..')
    }

    if (!isValidModelId(modelId))
      throw new Error(
        `Invalid modelId: ${modelId}. Only alphanumeric and / _ - . characters are allowed.`
      )

    const configPath = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
      'model.yml',
    ])
    if (await fs.existsSync(configPath))
      throw new Error(`Model ${modelId} already exists`)

    const sourcePath = opts.modelPath

    if (sourcePath.startsWith('https://')) {
      const janDataFolderPath = await getJanDataFolderPath()
      const modelDir = await joinPath([
        janDataFolderPath,
        'llamacpp',
        'models',
        modelId,
      ])

      // Determine filename from URL
      const urlParts = sourcePath.split('/')
      const filename = urlParts[urlParts.length - 1] || 'model.gguf'
      const localPath = await joinPath([modelDir, filename])

      const downloadManager = window.core.extensionManager.getByName(
        '@janhq/download-extension'
      )

      const downloadItems: any[] = [
        {
          url: sourcePath,
          save_path: localPath,
          model_id: modelId,
        },
      ]

      if (opts.files && opts.files.length > 0) {
        for (const file of opts.files) {
          downloadItems.push({
            url: file.url,
            save_path: await joinPath([modelDir, file.filename]),
            model_id: modelId,
          })
        }
      }

      try {
        await downloadManager.downloadFiles(
          downloadItems,
          this.createDownloadTaskId(modelId),
          (transferred: number, total: number) => {
            events.emit(DownloadEvent.onFileDownloadUpdate, {
              modelId,
              percent: transferred / total,
              size: { transferred, total },
              downloadType: 'Model',
            })
          }
        )
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        if (
          errorMessage.includes('cancelled') ||
          errorMessage.includes('aborted')
        ) {
          logger.info('Download stopped for model:', modelId)
          events.emit(DownloadEvent.onFileDownloadStopped, {
            modelId,
            downloadType: 'Model',
          })
          return
        }
        logger.error('Error downloading model:', modelId, error)
        events.emit(DownloadEvent.onFileDownloadError, {
          modelId,
          downloadType: 'Model',
          error: errorMessage,
        })
        throw error
      }

      await fs.mkdir(modelDir)
      const modelConfig: any = {
        model_path: `llamacpp/models/${modelId}/${filename}`,
        name: modelId,
        size_bytes: opts.modelSize ?? 0,
      }

      await invoke<void>('write_yaml', {
        data: modelConfig,
        savePath: configPath,
      })

      events.emit(AppEvent.onModelImported, {
        modelId,
        modelPath: modelConfig.model_path,
        size_bytes: modelConfig.size_bytes,
      })

      events.emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
        modelId,
        downloadType: 'Model',
      })
    } else {
      // Local file import
      if (!(await fs.existsSync(sourcePath))) {
        throw new Error(`File not found: ${sourcePath}`)
      }

      const stat = await fs.fileStat(sourcePath)
      const size_bytes = stat.size

      const modelConfig: any = {
        model_path: sourcePath,
        name: modelId,
        size_bytes,
      }

      const modelDir = await joinPath([
        await this.getProviderPath(),
        'models',
        modelId,
      ])
      await fs.mkdir(modelDir)

      await invoke<void>('write_yaml', {
        data: modelConfig,
        savePath: configPath,
      })

      events.emit(AppEvent.onModelImported, {
        modelId,
        modelPath: sourcePath,
        size_bytes,
      })
    }
  }

  private createDownloadTaskId(modelId: string) {
    const cleanModelId = modelId.includes('.')
      ? modelId.slice(0, modelId.indexOf('.'))
      : modelId
    return `${this.provider}/${cleanModelId}`
  }

  override async abortImport(modelId: string): Promise<void> {
    const taskId = this.createDownloadTaskId(modelId)
    const downloadManager = window.core.extensionManager.getByName(
      '@janhq/download-extension'
    )

    try {
      await downloadManager.cancelDownload(taskId)
    } catch (cancelError) {
      logger.warn('Failed to cancel download task:', cancelError)
    }

    await this.deleteModelFolder(modelId)
  }

  override async pauseImport(modelId: string): Promise<void> {
    const taskId = this.createDownloadTaskId(modelId)
    const downloadManager = window.core.extensionManager.getByName(
      '@janhq/download-extension'
    )
    await downloadManager.pauseDownload(taskId)
  }

  private async deleteModelFolder(modelId: string): Promise<void> {
    try {
      const modelDir = await joinPath([
        await this.getProviderPath(),
        'models',
        modelId,
      ])

      if (await fs.existsSync(modelDir)) {
        logger.info(`Cleaning up model directory: ${modelDir}`)
        await fs.rm(modelDir)
      }
    } catch (deleteError) {
      logger.warn('Failed to delete model directory:', deleteError)
    }
  }

  override async getLoadedModels(): Promise<string[]> {
    try {
      return await invoke<string[]>(
        'plugin:mistralrs|get_mistralrs_loaded_models'
      )
    } catch (e) {
      logger.error(e)
      throw new Error(String(e))
    }
  }

  async checkBackendForUpdates(): Promise<{
    updateNeeded: boolean
    newVersion: string
    currentVersion?: string
    targetBackend?: string
  }> {
    return { updateNeeded: false, newVersion: 'integrated', currentVersion: 'integrated' }
  }

  async updateBackend(
    _targetBackendString: string
  ): Promise<{ wasUpdated: boolean; newBackend: string }> {
    return { wasUpdated: false, newBackend: 'integrated' }
  }

  async installBackend(_archivePath: string): Promise<void> {
    // no-op: mistralrs is now embedded in the app binary
  }
}

// Internal model config type - mirrors what's stored in model.yml
interface ModelConfig {
  name?: string
  model_path: string
  size_bytes?: number
  embedding?: boolean
}
