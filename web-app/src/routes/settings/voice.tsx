import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'
import SettingsMenu from '@/containers/SettingsMenu'
import HeaderPage from '@/containers/HeaderPage'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, Loader2, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useDownloadStore } from '@/hooks/useDownloadStore'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.voice as any)({
  component: VoiceSettingsContent,
})

// ── Download URLs ─────────────────────────────────────────────────────────────
// whisper.cpp pre-built server binaries (official GitHub releases)
// Windows: zip archive containing whisper-server.exe + required DLLs
// macOS/Linux: no pre-built server binary — install via brew / build from source
const WHISPER_SERVER_WIN_ZIP_URL =
  'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.4/whisper-bin-x64.zip'
// Whisper GGML model files hosted on Hugging Face
const WHISPER_MODEL_URLS: Record<string, string> = {
  tiny: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  small:
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  medium:
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
}
// Kokoro-ONNX server binary
const KOKORO_SERVER_URLS: Record<string, string> = {
  win32:
    'https://github.com/thewh1teagle/kokoro-onnx/releases/latest/download/kokoro-server-windows-x64.exe',
  darwin:
    'https://github.com/thewh1teagle/kokoro-onnx/releases/latest/download/kokoro-server-macos-arm64',
  linux:
    'https://github.com/thewh1teagle/kokoro-onnx/releases/latest/download/kokoro-server-linux-x64',
}

const WHISPER_MODEL_SIZES = ['tiny', 'base', 'small', 'medium'] as const
type WhisperModelSize = (typeof WHISPER_MODEL_SIZES)[number]
type TtsBackend = 'kokoro' | 'qwen3tts'

// Known Qwen3-TTS model variants available on HuggingFace.
const QWEN3TTS_MODELS = [
  {
    id: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
    label: '0.6B Custom Voice',
    size: '~3 GB',
    recommended: true,
  },
  {
    id: 'Qwen/Qwen3-TTS',
    label: 'Full Model',
    size: '~7 GB',
    recommended: false,
  },
] as const

/** Return a Tauri-event-safe download taskId for a Qwen3-TTS model.
 * Tauri event names allow only: alphanumeric, `-`, `/`, `:`, `_`.
 * Replace '/' with '--' first (mirrors Rust path naming), then strip any remaining invalid chars. */
function qwen3ttsTaskId(modelId: string): string {
  return 'voice-qwen3tts-' + modelId.replace('/', '--').replace(/[^a-zA-Z0-9\-_:/]/g, '_')
}

// ── Extension settings helpers ────────────────────────────────────────────────
const EXTENSION_KEY = '@janhq/voice-call-extension'

function getExtSetting(key: string, def: string): string {
  try {
    const raw = localStorage.getItem(EXTENSION_KEY)
    if (!raw) return def
    const arr = JSON.parse(raw) as Array<{ key: string; controllerProps: { value: unknown } }>
    return (arr.find((s) => s.key === key)?.controllerProps?.value as string) ?? def
  } catch {
    return def
  }
}

function setExtSetting(key: string, value: string): void {
  try {
    const raw = localStorage.getItem(EXTENSION_KEY)
    const arr: Array<{ key: string; controllerProps: { value: unknown } }> = raw
      ? JSON.parse(raw)
      : []
    const idx = arr.findIndex((s) => s.key === key)
    if (idx >= 0) arr[idx].controllerProps.value = value
    else arr.push({ key, controllerProps: { value } })
    localStorage.setItem(EXTENSION_KEY, JSON.stringify(arr))
  } catch (e) {
    console.error('[VoiceSettings] failed to write ext setting', e)
  }
}

const MODEL_LABELS: Record<WhisperModelSize, string> = {
  tiny: 'Tiny (~75 MB, fastest)',
  base: 'Base (~142 MB)',
  small: 'Small (~466 MB, recommended)',
  medium: 'Medium (~1.5 GB)',
}

interface DependencyStatus {
  whisper_server: boolean
  kokoro_server: boolean
  whisper_models: Record<WhisperModelSize, boolean>
  data_folder: string
  python_available: boolean
  python_executable: string | null
  qwen3tts_server_script: boolean
  /// Sanitized dir names (model IDs with '/' → '--') for all downloaded models.
  qwen3tts_downloaded_models: string[]
  whisper_running: boolean
  kokoro_running: boolean
  qwen3tts_running: boolean
}

function StatusIcon({ installed }: { installed: boolean }) {
  return installed ? (
    <CheckCircle2 size={16} className="text-green-500 shrink-0" />
  ) : (
    <AlertCircle size={16} className="text-muted-foreground/50 shrink-0" />
  )
}

function DownloadProgressBar({ progress }: { progress: number }) {
  return (
    <div className="flex items-center gap-2 w-28">
      <Progress value={progress} className="border h-1.5" />
      <span className="text-xs text-muted-foreground w-8 text-right">
        {Math.round(progress)}%
      </span>
    </div>
  )
}

function VoiceSettingsContent() {
  const [status, setStatus] = useState<DependencyStatus | null>(null)
  const { downloads, updateProgress, removeDownload } = useDownloadStore()
  const [qwen3ttsModelId, setQwen3ttsModelIdState] = useState<string>(
    () => getExtSetting('qwen3tts_model', 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')
  )

  const changeQwen3ttsModel = (val: string) => {
    setQwen3ttsModelIdState(val)
    setExtSetting('qwen3tts_model', val)
  }

  // Server start/stop state
  const [isStartingWhisper, setIsStartingWhisper] = useState(false)
  const [isStartingKokoro, setIsStartingKokoro] = useState(false)
  const [isStartingQwen3tts, setIsStartingQwen3tts] = useState(false)
  const platform = (window as Window & { __TAURI_INTERNALS__?: { platform?: string } }).__TAURI_INTERNALS__?.platform ?? 'win32'

  // ── Extension settings state ──────────────────────────────────────────────
  const [ttsBackend, setTtsBackendState] = useState<TtsBackend>(
    () => getExtSetting('tts_backend', 'kokoro') as TtsBackend
  )
  const [sttModel, setSttModelState] = useState<WhisperModelSize>(
    () => getExtSetting('stt_model_size', 'tiny') as WhisperModelSize
  )

  const changeTtsBackend = (val: TtsBackend) => {
    setTtsBackendState(val)
    setExtSetting('tts_backend', val)
  }
  const changeSttModel = (val: WhisperModelSize) => {
    setSttModelState(val)
    setExtSetting('stt_model_size', val)
  }

  // When status loads, if the selected model isn't installed, switch to the
  // first installed one so the voice call can succeed without manual action.
  useEffect(() => {
    if (!status) return
    if (status.whisper_models[sttModel]) return // already installed
    const firstInstalled = WHISPER_MODEL_SIZES.find((s) => status.whisper_models[s])
    if (firstInstalled) changeSttModel(firstInstalled)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<DependencyStatus>('voice_check_dependencies')
      setStatus(result)
    } catch (err) {
      console.error('[VoiceSettings] check deps failed', err)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // ── Download helpers ───────────────────────────────────────────────────────
  // Tauri emits `download-{taskId}` events with { transferred, total }.
  // We listen directly on those events instead of the Jan events bus (which
  // is only populated by the llamacpp extension, not raw invoke calls).
  const activeUnlistenRef = useRef<Map<string, () => void>>(new Map())

  const startDownload = useCallback(
    async (taskId: string, url: string, savePath: string, onDone?: () => void) => {
      updateProgress(taskId, 0, taskId, 0, 0)

      // Subscribe to the Tauri progress event for this task
      const unlisten = await listen<{ transferred: number; total: number }>(
        `download-${taskId}`,
        (event) => {
          const { transferred, total } = event.payload
          const pct = total > 0 ? (transferred / total) * 100 : 0
          updateProgress(taskId, pct, taskId, transferred, total)
        }
      )
      activeUnlistenRef.current.set(taskId, unlisten)

      try {
        await invoke('download_files', {
          items: [{ url, save_path: savePath, model_id: taskId }],
          taskId,
          headers: {},
        })
        unlisten()
        activeUnlistenRef.current.delete(taskId)
        removeDownload(taskId)
        await refresh()
        onDone?.()
      } catch (err) {
        unlisten()
        activeUnlistenRef.current.delete(taskId)
        const msg = err instanceof Error ? err.message : String(err)
        toast.error('Download failed', { description: msg })
        removeDownload(taskId)
      }
    },
    [refresh, updateProgress, removeDownload]
  )

  // Multi-item variant — used for HuggingFace model downloads (many files, single task).
  const startMultiDownload = useCallback(
    async (
      taskId: string,
      items: Array<{ url: string; save_path: string; model_id: string }>
    ) => {
      updateProgress(taskId, 0, taskId, 0, 0)

      const unlisten = await listen<{ transferred: number; total: number }>(
        `download-${taskId}`,
        (event) => {
          const { transferred, total } = event.payload
          const pct = total > 0 ? (transferred / total) * 100 : 0
          updateProgress(taskId, pct, taskId, transferred, total)
        }
      )
      activeUnlistenRef.current.set(taskId, unlisten)

      try {
        await invoke('download_files', { items, taskId, headers: {} })
        unlisten()
        activeUnlistenRef.current.delete(taskId)
        removeDownload(taskId)
        await refresh()
      } catch (err) {
        unlisten()
        activeUnlistenRef.current.delete(taskId)
        const msg = err instanceof Error ? err.message : String(err)
        toast.error('Download failed', { description: msg })
        removeDownload(taskId)
      }
    },
    [refresh, updateProgress, removeDownload]
  )

  // Clean up any lingering listeners on unmount
  useEffect(() => {
    return () => {
      activeUnlistenRef.current.forEach((unlisten) => unlisten())
    }
  }, [])

  const [extracting, setExtracting] = useState(false)

  // On Windows: after the zip downloads, auto-extract whisper-server.exe + DLLs
  const extractWhisperZip = useCallback(async () => {
    setExtracting(true)
    try {
      await invoke('voice_extract_whisper_zip')
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('Extraction failed', { description: msg })
    } finally {
      setExtracting(false)
    }
  }, [refresh])

  const downloadWhisperServer = () => {
    if (platform === 'win32') {
      startDownload(
        'voice-whisper-server-zip',
        WHISPER_SERVER_WIN_ZIP_URL,
        'voice/whisper/whisper-bin-x64.zip',
        () => extractWhisperZip()
      )
    }
    // macOS / Linux handled by UI (brew / build from source instructions)
  }

  const downloadKokoroServer = () => {
    const url = KOKORO_SERVER_URLS[platform] ?? KOKORO_SERVER_URLS['linux']
    const ext = platform === 'win32' ? '.exe' : ''
    startDownload('voice-kokoro-server', url, `voice/kokoro/kokoro-server${ext}`)
  }

  const downloadWhisperModel = (size: WhisperModelSize) => {
    const url = WHISPER_MODEL_URLS[size]
    startDownload(`voice-whisper-model-${size}`, url, `voice/whisper/ggml-${size}.bin`)
  }

  const downloadQwen3ttsModel = useCallback(async (modelId: string) => {
    const sanitized = modelId.replace('/', '--')
    const taskId = qwen3ttsTaskId(modelId)

    // Fetch the file list from HuggingFace Hub API
    let siblings: Array<{ rfilename: string }>
    try {
      const resp = await fetch(`https://huggingface.co/api/models/${modelId}`)
      if (!resp.ok) throw new Error(`HuggingFace API error: ${resp.status}`)
      const info = await resp.json()
      siblings = (info.siblings ?? []) as Array<{ rfilename: string }>
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('Failed to fetch model file list from HuggingFace', { description: msg })
      return
    }

    // Build items — same path sanitization as Rust: '/' -> '--'
    const destBase = `voice/qwen3tts/models/${sanitized}`
    const items = siblings.map(({ rfilename }) => ({
      url: `https://huggingface.co/${modelId}/resolve/main/${rfilename}`,
      save_path: `${destBase}/${rfilename}`,
      model_id: `${taskId}/${rfilename}`,
    }))

    await startMultiDownload(taskId, items)
  }, [startMultiDownload])

  const removeQwen3ttsModel = useCallback(async (modelId: string) => {
    try {
      await invoke('voice_remove_qwen3tts_model', { modelId })
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('Failed to remove model', { description: msg })
    }
  }, [refresh])

  // ── Server start/stop ─────────────────────────────────────────────────────
  const startWhisperServer = useCallback(async () => {
    setIsStartingWhisper(true)
    try {
      await invoke('voice_start_whisper_server', { port: 18765, modelSize: sttModel })
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('Failed to start Whisper server', { description: msg })
    } finally {
      setIsStartingWhisper(false)
    }
  }, [sttModel, refresh])

  const stopWhisperServer = useCallback(async () => {
    try {
      await invoke('voice_stop_whisper_server')
      await refresh()
    } catch (err) {
      console.error('[VoiceSettings] stop whisper failed', err)
    }
  }, [refresh])

  const startKokoroServer = useCallback(async () => {
    setIsStartingKokoro(true)
    try {
      await invoke('voice_start_kokoro_server', { port: 18766 })
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('Failed to start Kokoro server', { description: msg })
    } finally {
      setIsStartingKokoro(false)
    }
  }, [refresh])

  const stopKokoroServer = useCallback(async () => {
    try {
      await invoke('voice_stop_kokoro_server')
      await refresh()
    } catch (err) {
      console.error('[VoiceSettings] stop kokoro failed', err)
    }
  }, [refresh])

  const startQwen3ttsServer = useCallback(async () => {
    setIsStartingQwen3tts(true)
    try {
      await invoke('voice_start_qwen3tts_server', { port: 18767, model: qwen3ttsModelId })
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error('Failed to start Qwen3-TTS server', { description: msg })
    } finally {
      setIsStartingQwen3tts(false)
    }
  }, [qwen3ttsModelId, refresh])

  const stopQwen3ttsServer = useCallback(async () => {
    try {
      await invoke('voice_stop_qwen3tts_server')
      await refresh()
    } catch (err) {
      console.error('[VoiceSettings] stop qwen3tts failed', err)
    }
  }, [refresh])

  function renderWhisperServerAction(installed: boolean) {
    if (platform !== 'win32') {
      if (installed) return <span className="text-xs text-green-500 font-medium">Installed</span>
      return (
        <Button size="sm" variant="outline" asChild>
          <a
            href={
              platform === 'darwin'
                ? 'https://formulae.brew.sh/formula/whisper-cpp'
                : 'https://github.com/ggml-org/whisper.cpp#build'
            }
            target="_blank"
            rel="noreferrer"
          >
            {platform === 'darwin' ? 'brew install' : 'Build from source'}
          </a>
        </Button>
      )
    }
    const zipDl = downloads['voice-whisper-server-zip']
    if (zipDl) {
      return (
        <div className="flex items-center gap-2">
          <DownloadProgressBar progress={zipDl.progress} />
          <span className="text-xs text-muted-foreground">Downloading…</span>
        </div>
      )
    }
    if (extracting) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-xs">Extracting…</span>
        </div>
      )
    }
    if (installed) {
      return (
        <div className="flex items-center gap-2">
          <span className="text-xs text-green-500 font-medium">Installed</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={extractWhisperZip}
            className="gap-1 text-xs h-6 px-2 text-muted-foreground"
            title="Re-extract from zip to repair missing DLLs"
          >
            <Loader2 size={11} className={extracting ? 'animate-spin' : 'hidden'} />
            Re-extract
          </Button>
        </div>
      )
    }
    return (
      <Button size="sm" variant="outline" onClick={downloadWhisperServer} className="gap-1.5">
        <Download size={14} />
        Download
      </Button>
    )
  }

  function renderAction(taskId: string, installed: boolean, onDownload: () => void) {
    const dl = downloads[taskId]
    if (dl) {
      return <DownloadProgressBar progress={dl.progress} />
    }
    if (installed) {
      return (
        <span className="text-xs text-green-500 font-medium">Installed</span>
      )
    }
    return (
      <Button size="sm" variant="outline" onClick={onDownload} className="gap-1.5">
        <Download size={14} />
        Download
      </Button>
    )
  }

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">Settings</span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col gap-4 w-full">
            {/* ── Configuration ─────────────────────────────────────────── */}
            <Card
              header={
                <div className="mb-4">
                  <h1 className="text-foreground font-studio font-medium text-base">
                    Voice Configuration
                  </h1>
                  <p className="text-sm text-muted-foreground mt-1">
                    Select which engines to use for voice calls. Download the required binaries below.
                  </p>
                </div>
              }
            >
              <CardItem
                title="TTS Backend"
                description="Text-to-speech engine used during voice calls."
                actions={
                  <RadioGroup
                    value={ttsBackend}
                    onValueChange={(v) => changeTtsBackend(v as TtsBackend)}
                    className="flex gap-4"
                  >
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem value="kokoro" id="be-kokoro" />
                      <label htmlFor="be-kokoro" className="text-sm cursor-pointer">
                        Kokoro
                        {status?.kokoro_server ? (
                          <CheckCircle2 size={12} className="inline ml-1 text-green-500" />
                        ) : (
                          <span className="ml-1 text-xs text-muted-foreground/60">(not installed)</span>
                        )}
                      </label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <RadioGroupItem value="qwen3tts" id="be-qwen3" />
                      <label htmlFor="be-qwen3" className="text-sm cursor-pointer">
                        Qwen3-TTS
                        {status?.python_available && status?.qwen3tts_server_script ? (
                          <CheckCircle2 size={12} className="inline ml-1 text-green-500" />
                        ) : (
                          <span className="ml-1 text-xs text-muted-foreground/60">(needs setup)</span>
                        )}
                      </label>
                    </div>
                  </RadioGroup>
                }
              />
              <CardItem
                title="STT Model Size"
                description="Whisper model used for speech recognition. Only installed models can be used."
                actions={
                  <RadioGroup
                    value={sttModel}
                    onValueChange={(v) => changeSttModel(v as WhisperModelSize)}
                    className="flex flex-wrap gap-3"
                  >
                    {WHISPER_MODEL_SIZES.map((size) => {
                      const installed = status?.whisper_models[size] ?? false
                      const isSelected = sttModel === size
                      return (
                        <div key={size} className="flex items-center gap-1.5">
                          <RadioGroupItem
                            value={size}
                            id={`stt-${size}`}
                            disabled={!installed}
                            className={!installed ? 'opacity-30' : ''}
                          />
                          <label
                            htmlFor={`stt-${size}`}
                            className={`text-sm ${
                              !installed
                                ? 'text-muted-foreground/50 cursor-not-allowed'
                                : isSelected
                                  ? 'text-foreground font-medium cursor-pointer'
                                  : 'cursor-pointer'
                            }`}
                          >
                            {size}
                            {installed ? (
                              <CheckCircle2 size={12} className="inline ml-1 text-green-500" />
                            ) : (
                              <span className="ml-1 text-xs">(not installed)</span>
                            )}
                          </label>
                        </div>
                      )
                    })}
                  </RadioGroup>
                }
              />
              {status && !status.whisper_models[sttModel] && (
                <p className="text-xs text-amber-500 px-2 pb-1">
                  ⚠ Selected model &ldquo;{sttModel}&rdquo; is not installed. Download it below or select an installed model.
                </p>
              )}
            </Card>
            {/* ── STT (Whisper) ─────────────────────────────────────────── */}
            <Card
              header={
                <div className="mb-4">
                  <h1 className="text-foreground font-studio font-medium text-base">
                    Speech-to-Text (Whisper)
                  </h1>
                  <p className="text-sm text-muted-foreground mt-1">
                    Local speech recognition server powered by whisper.cpp.
                    {status && (
                      <span className="ml-2 text-xs text-muted-foreground/70 font-mono">
                        {status.data_folder}/voice/whisper/
                      </span>
                    )}
                  </p>
                </div>
              }
            >
              {!status ? (
                <div className="flex items-center gap-2 text-muted-foreground py-2">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-sm">Checking…</span>
                </div>
              ) : (
                <>
                  <CardItem
                    title={
                      <div className="flex items-center gap-2">
                        <StatusIcon installed={status.whisper_server} />
                        <span>whisper-server binary</span>
                      </div>
                    }
                    description={
                      platform === 'win32'
                        ? 'Downloads whisper-bin-x64.zip and extracts whisper-server.exe + DLLs.'
                        : platform === 'darwin'
                          ? 'Install via Homebrew: brew install whisper-cpp'
                          : 'Build from source: https://github.com/ggml-org/whisper.cpp#build'
                    }
                    actions={renderWhisperServerAction(status.whisper_server)}
                  />
                  {WHISPER_MODEL_SIZES.map((size) => (
                    <CardItem
                      key={size}
                      title={
                        <div className="flex items-center gap-2">
                          <StatusIcon
                            installed={
                              status.whisper_models[size] ?? false
                            }
                          />
                          <span>Model: {MODEL_LABELS[size]}</span>
                        </div>
                      }
                      description={`ggml-${size}.bin — GGML weights file.`}
                      actions={renderAction(
                        `voice-whisper-model-${size}`,
                        status.whisper_models[size] ?? false,
                        () => downloadWhisperModel(size)
                      )}
                    />
                  ))}
                  {/* Server start/stop */}
                  <CardItem
                    title={
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block w-2 h-2 rounded-full ${
                            status.whisper_running ? 'bg-green-500' : 'bg-muted-foreground/40'
                          }`}
                        />
                        <span>Server</span>
                        <span className={`text-xs font-medium ${
                          status.whisper_running ? 'text-green-500' : 'text-muted-foreground'
                        }`}>
                          {status.whisper_running ? 'Running' : 'Stopped'}
                        </span>
                      </div>
                    }
                    description={`Port 18765 — uses the "${sttModel}" model.`}
                    actions={
                      isStartingWhisper ? (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 size={14} className="animate-spin" />
                          <span className="text-xs">Starting…</span>
                        </div>
                      ) : status.whisper_running ? (
                        <Button size="sm" variant="outline" onClick={stopWhisperServer}>
                          Stop
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={startWhisperServer}
                          disabled={!status.whisper_server || !status.whisper_models[sttModel]}
                        >
                          Start
                        </Button>
                      )
                    }
                  />
                </>
              )}
            </Card>

            {/* ── TTS (Kokoro) ──────────────────────────────────────────── */}
            <Card
              header={
                <div className="mb-4">
                  <h1 className="text-foreground font-studio font-medium text-base">
                    Text-to-Speech (Kokoro)
                  </h1>
                  <p className="text-sm text-muted-foreground mt-1">
                    Local neural TTS server powered by Kokoro-ONNX.
                    {status && (
                      <span className="ml-2 text-xs text-muted-foreground/70 font-mono">
                        {status.data_folder}/voice/kokoro/
                      </span>
                    )}
                  </p>
                </div>
              }
            >
              {!status ? (
                <div className="flex items-center gap-2 text-muted-foreground py-2">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-sm">Checking…</span>
                </div>
              ) : (
                <>
                  <CardItem
                    title={
                      <div className="flex items-center gap-2">
                        <StatusIcon installed={status.kokoro_server} />
                        <span>kokoro-server binary</span>
                      </div>
                    }
                    description="The HTTP synthesis server process (Kokoro-ONNX)."
                    actions={renderAction(
                      'voice-kokoro-server',
                      status.kokoro_server,
                      downloadKokoroServer
                    )}
                  />
                  {/* Server start/stop */}
                  <CardItem
                    title={
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block w-2 h-2 rounded-full ${
                            status.kokoro_running ? 'bg-green-500' : 'bg-muted-foreground/40'
                          }`}
                        />
                        <span>Server</span>
                        <span className={`text-xs font-medium ${
                          status.kokoro_running ? 'text-green-500' : 'text-muted-foreground'
                        }`}>
                          {status.kokoro_running ? 'Running' : 'Stopped'}
                        </span>
                      </div>
                    }
                    description="Port 18766"
                    actions={
                      isStartingKokoro ? (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 size={14} className="animate-spin" />
                          <span className="text-xs">Starting…</span>
                        </div>
                      ) : status.kokoro_running ? (
                        <Button size="sm" variant="outline" onClick={stopKokoroServer}>
                          Stop
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={startKokoroServer}
                          disabled={!status.kokoro_server}
                        >
                          Start
                        </Button>
                      )
                    }
                  />
                </>
              )}
            </Card>
            {/* ── TTS (Qwen3-TTS) ───────────────────────────────────────── */}
            <Card
              header={
                <div className="mb-4">
                  <h1 className="text-foreground font-studio font-medium text-base">
                    Text-to-Speech (Qwen3-TTS)
                  </h1>
                  <p className="text-sm text-muted-foreground mt-1">
                    Qwen3-TTS runs via Python and requires{' '}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">pip install faster-qwen3-tts soundfile</code>.
                    Download model weights below before starting voice calls.
                    {' '}<span className="text-amber-500">
                      RTX 50xx (Blackwell): first run{' '}
                      <code className="text-xs bg-muted px-1 py-0.5 rounded">pip install "torch&gt;=2.7.0" --index-url https://download.pytorch.org/whl/cu128</code>.
                    </span>
                  </p>
                </div>
              }
            >
              {!status ? (
                <div className="flex items-center gap-2 text-muted-foreground py-2">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-sm">Checking…</span>
                </div>
              ) : (
                <>
                  <CardItem
                    title={
                      <div className="flex items-center gap-2">
                        <StatusIcon installed={status.python_available} />
                        <span>Python 3 in PATH</span>
                      </div>
                    }
                    description={
                      status.python_available
                        ? `Found: ${status.python_executable}`
                        : 'Python 3 not found. Install Python 3 and ensure it is in your PATH.'
                    }
                    actions={
                      status.python_available ? (
                        <span className="text-xs text-green-500 font-medium">Found</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          asChild
                        >
                          <a
                            href="https://www.python.org/downloads/"
                            target="_blank"
                            rel="noreferrer"
                          >
                            python.org
                          </a>
                        </Button>
                      )
                    }
                  />
                  <CardItem
                    title="Install faster-qwen3-tts package"
                    description="Faster CUDA-graph-accelerated Qwen3-TTS (5-10x speedup over stock qwen-tts). Run once in your terminal."
                    actions={
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          navigator.clipboard
                            .writeText('pip install -U faster-qwen3-tts soundfile')
                            .then(() => toast.success('Copied to clipboard'))
                        }}
                      >
                        Copy command
                      </Button>
                    }
                  />
                  {/* ── Model weights — choose, download, remove ─── */}
                  <CardItem
                    title="Model weights"
                    description="Select the model to use for synthesis. Download it before starting the server."
                    actions={null}
                  />
                  {QWEN3TTS_MODELS.map((model) => {
                    const sanitized = model.id.replace('/', '--')
                    const taskId = qwen3ttsTaskId(model.id)
                    const isDownloaded = status.qwen3tts_downloaded_models.includes(sanitized)
                    const isActive = qwen3ttsModelId === model.id
                    const dl = downloads[taskId]
                    return (
                      <CardItem
                        key={model.id}
                        title={
                          <div className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="qwen3tts-model"
                              id={`qwen3tts-${sanitized}`}
                              checked={isActive}
                              onChange={() => changeQwen3ttsModel(model.id)}
                              className="accent-primary"
                            />
                            <label htmlFor={`qwen3tts-${sanitized}`} className="cursor-pointer flex items-center gap-1.5">
                              <StatusIcon installed={isDownloaded} />
                              <span>{model.label}</span>
                              {model.recommended && (
                                <span className="text-xs text-muted-foreground">(recommended)</span>
                              )}
                            </label>
                          </div>
                        }
                        description={`${model.id} — ${model.size}`}
                        actions={(() => {
                          if (dl) {
                            return (
                              <div className="flex items-center gap-2">
                                <DownloadProgressBar progress={dl.progress} />
                                <span className="text-xs text-muted-foreground">Downloading…</span>
                              </div>
                            )
                          }
                          if (isDownloaded) {
                            return (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-green-500 font-medium">Downloaded</span>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-xs h-6 px-2 text-destructive hover:text-destructive"
                                  onClick={() => removeQwen3ttsModel(model.id)}
                                >
                                  Remove
                                </Button>
                              </div>
                            )
                          }
                          return (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => downloadQwen3ttsModel(model.id)}
                              className="gap-1.5"
                            >
                              <Download size={14} />
                              Download
                            </Button>
                          )
                        })()}
                      />
                    )
                  })}
                  {/* Server start/stop */}
                  <CardItem
                    title={
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-block w-2 h-2 rounded-full ${
                            status.qwen3tts_running ? 'bg-green-500' : 'bg-muted-foreground/40'
                          }`}
                        />
                        <span>Server</span>
                        <span className={`text-xs font-medium ${
                          status.qwen3tts_running ? 'text-green-500' : 'text-muted-foreground'
                        }`}>
                          {status.qwen3tts_running ? 'Running' : 'Stopped'}
                        </span>
                      </div>
                    }
                    description="Port 18767 — model loads in background after start (takes 10–30 s on first run)."
                    actions={
                      isStartingQwen3tts ? (
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 size={14} className="animate-spin" />
                          <span className="text-xs">Starting…</span>
                        </div>
                      ) : status.qwen3tts_running ? (
                        <Button size="sm" variant="outline" onClick={stopQwen3ttsServer}>
                          Stop
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={startQwen3ttsServer}
                          disabled={
                            !status.python_available ||
                            !status.qwen3tts_downloaded_models.includes(qwen3ttsModelId.replace('/', '--'))
                          }
                        >
                          Start
                        </Button>
                      )
                    }
                  />
                </>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
