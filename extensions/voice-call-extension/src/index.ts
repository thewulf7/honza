import { VoiceExtension, type SpeechSynthesisResult, type SettingComponentProps } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import settingsJson from '../settings.json'

const SETTINGS = settingsJson as unknown as SettingComponentProps[]

// ── Server port constants ─────────────────────────────────────────────────────
const WHISPER_PORT = 18765
const KOKORO_PORT = 18766
const QWEN3TTS_PORT = 18767

// URL constants used only for _waitForServer polling (passed to voice_ping_server)
const WHISPER_INFERENCE_URL = `http://127.0.0.1:${WHISPER_PORT}/inference`
const KOKORO_SYNTHESIS_URL = `http://127.0.0.1:${KOKORO_PORT}/synthesize`
const QWEN3TTS_SYNTHESIS_URL = `http://127.0.0.1:${QWEN3TTS_PORT}/synthesize`

export default class VoiceCallExtension extends VoiceExtension {
  private sttModelSize: string = 'tiny'
  private ttsBackend: string = 'kokoro'
  private ttsVoice: string = 'af_heart'
  private ttsSpeed: number = 1.0
  private qwen3ttsSpeaker: string = 'Ryan'
  private qwen3ttsLanguage: string = 'Auto'
  private qwen3ttsModel: string = 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'
  private _sttReady = false
  private _ttsReady = false

  async onLoad(): Promise<void> {
    await this.registerSettings(SETTINGS)
    this.sttModelSize = await this.getSetting<string>('stt_model_size', 'tiny')
    this.ttsBackend = await this.getSetting<string>('tts_backend', 'kokoro')
    this.ttsVoice = await this.getSetting<string>('tts_voice', 'af_heart')
    this.ttsSpeed = await this.getSetting<number>('tts_speed', 1.0)
    this.qwen3ttsSpeaker = await this.getSetting<string>('qwen3tts_speaker', 'Ryan')
    this.qwen3ttsLanguage = await this.getSetting<string>('qwen3tts_language', 'Auto')
    this.qwen3ttsModel = await this.getSetting<string>(
      'qwen3tts_model',
      'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'
    )
  }

  onUnload(): void {
    this.stopServers().catch(console.error)
  }

  // ── VoiceExtension impl ─────────────────────────────────────────────────────

  onSettingUpdate<T>(key: string, value: T): void {
    if (key === 'stt_model_size') this.sttModelSize = value as string
    else if (key === 'tts_backend') this.ttsBackend = value as string
    else if (key === 'tts_voice') this.ttsVoice = value as string
    else if (key === 'tts_speed') this.ttsSpeed = Number(value)
    else if (key === 'qwen3tts_model') this.qwen3ttsModel = value as string
    else if (key === 'qwen3tts_speaker') this.qwen3ttsSpeaker = value as string
    else if (key === 'qwen3tts_language') this.qwen3ttsLanguage = value as string
  }

  async startServers(): Promise<void> {
    // Re-read settings to pick up any changes made since onLoad()
    this.sttModelSize = await this.getSetting<string>('stt_model_size', 'tiny')
    this.ttsBackend = await this.getSetting<string>('tts_backend', 'kokoro')
    this.qwen3ttsModel = await this.getSetting<string>(
      'qwen3tts_model',
      'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'
    )
    // Sequential: if STT fails, skip TTS entirely (avoids background polling spam)
    await this._startSTT()
    await this._startTTS()
  }

  async stopServers(): Promise<void> {
    this._sttReady = false
    this._ttsReady = false
    await Promise.allSettled([
      invoke('voice_stop_whisper_server'),
      invoke('voice_stop_kokoro_server'),
      invoke('voice_stop_qwen3tts_server'),
    ])
  }

  async isSTTReady(): Promise<boolean> {
    return this._sttReady
  }

  async isTTSReady(): Promise<boolean> {
    return this._ttsReady
  }

  /**
   * Transcribe base64-encoded audio via local Whisper.cpp server.
   */
  async transcribe(audioBase64: string, format: 'mp3' | 'wav' | 'ogg' | 'flac'): Promise<string> {
    if (!this._sttReady) throw new Error('STT server is not ready')
    return invoke<string>('voice_transcribe', { audioBase64, format, port: WHISPER_PORT })
  }

  /**
   * Synthesize speech via the configured TTS backend (Kokoro or Qwen3-TTS).
   * Returns WAV base64 + optional phoneme timestamps.
   */
  async synthesize(text: string): Promise<SpeechSynthesisResult> {
    if (!this._ttsReady) throw new Error('TTS server is not ready')

    if (this.ttsBackend === 'qwen3tts') {
      return this._synthesizeQwen3TTS(text)
    }
    return this._synthesizeKokoro(text)
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async _synthesizeKokoro(text: string): Promise<SpeechSynthesisResult> {
    const res = await invoke<{
      audio_base64: string
      duration_ms?: number
      phonemes?: Array<{ phoneme: string; start_ms: number; end_ms: number }>
    }>('voice_synthesize_kokoro', {
      text,
      voice: this.ttsVoice,
      speed: this.ttsSpeed,
      port: KOKORO_PORT,
    })
    return {
      audioBase64: res.audio_base64,
      format: 'wav',
      durationMs: res.duration_ms,
      phonemes: res.phonemes?.map((p) => ({
        phoneme: p.phoneme,
        startMs: p.start_ms,
        endMs: p.end_ms,
      })),
    }
  }

  private async _synthesizeQwen3TTS(text: string): Promise<SpeechSynthesisResult> {
    const res = await invoke<{ audio_base64: string; duration_ms?: number }>(
      'voice_synthesize_qwen3tts',
      {
        text,
        speaker: this.qwen3ttsSpeaker,
        language: this.qwen3ttsLanguage,
        port: QWEN3TTS_PORT,
      }
    )
    return {
      audioBase64: res.audio_base64,
      format: 'wav',
      durationMs: res.duration_ms,
    }
  }

  private async _startSTT(): Promise<void> {
    await invoke('voice_start_whisper_server', {
      port: WHISPER_PORT,
      modelSize: this.sttModelSize,
    })
    this._sttReady = await this._waitForServer(WHISPER_INFERENCE_URL, 4)
    if (!this._sttReady) throw new Error('Whisper server failed to become ready')
  }

  private async _startTTS(): Promise<void> {
    if (this.ttsBackend === 'qwen3tts') {
      await invoke('voice_start_qwen3tts_server', {
        port: QWEN3TTS_PORT,
        model: this.qwen3ttsModel,
      })
      // Qwen3-TTS needs more startup time (loading PyTorch + model weights).
      // Use 3 s between attempts (120 × 3 s = 6 min budget) because the Python
      // server now binds immediately and responds to HEAD within ms; without a
      // delay we'd exhaust all attempts in ~1 second while the model is loading.
      this._ttsReady = await this._waitForServer(QWEN3TTS_SYNTHESIS_URL, 120, 3000)
      if (!this._ttsReady) throw new Error('Qwen3-TTS server failed to become ready')
    } else {
      await invoke('voice_start_kokoro_server', {
        port: KOKORO_PORT,
      })
      this._ttsReady = await this._waitForServer(KOKORO_SYNTHESIS_URL, 4)
      if (!this._ttsReady) throw new Error('Kokoro server failed to become ready')
    }
  }

  /**
   * Poll an endpoint until it responds or the attempt limit is reached.
   * Uses the Rust bridge (`voice_ping_server`) so the check runs in the native
   * process — the Tauri webview sandbox blocks direct localhost fetch() calls
   * on Windows, causing false ERR_CONNECTION_REFUSED even when the server is up.
   *
   * `voice_ping_server` return values:
   *   -1 = connection refused (server not up yet)
   *    0 = HTTP 503 — server up, not ready (model loading)
   *    1 = ready (2xx or 4xx — server is accepting connections)
   *    2 = HTTP 5xx ≠ 503 — permanent server error (bail immediately)
   *
   * @param delayMs Extra sleep between attempts (needed for fast-responding
   *   servers like Qwen3-TTS whose 503s return in <10 ms, otherwise all 120
   *   attempts exhaust in ~1 second instead of waiting for the model to load).
   */
  private async _waitForServer(url: string, maxAttempts: number, delayMs = 0): Promise<boolean> {
    // Give the process a moment to open its socket before the first probe.
    await new Promise((r) => setTimeout(r, 1500))
    for (let i = 0; i < maxAttempts; i++) {
      // Each invoke blocks in Rust for up to 30 s waiting for the server to
      // respond — no extra sleep needed for slow servers.
      const result = await invoke<number>('voice_ping_server', { url })
      if (result === 1) return true
      if (result === 2) return false  // permanent server error — stop retrying
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    }
    return false
  }
}
