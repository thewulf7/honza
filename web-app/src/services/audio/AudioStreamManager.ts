/**
 * AudioStreamManager
 *
 * Wraps the Web Audio API and MediaDevices to capture microphone input.
 *
 * Two modes driven by `isDirectAudioMode`:
 *  - STT mode (false): buffers audio until a silence gap is detected, then
 *    emits a single `utterance` event with the full base64-encoded WAV.
 *  - Direct audio mode (true): emits 100ms `audioChunk` events continuously
 *    as base64-encoded PCM WAV for direct multimodal LLM ingestion.
 *
 * Also emits `volumeLevel` (0–1) on every frame for the waveform visualizer.
 */

type AudioEventMap = {
  utterance: (audioBase64: string, format: 'wav') => void
  audioChunk: (audioBase64: string, format: 'wav') => void
  volumeLevel: (level: number) => void
  error: (err: Error) => void
}

type EventName = keyof AudioEventMap

const SILENCE_THRESHOLD = 0.01 // RMS below this is considered silence
const SILENCE_GAP_MS = 700 // ms of silence before utterance is emitted
const CHUNK_INTERVAL_MS = 100 // ms between direct-audio chunks
const SAMPLE_RATE = 16000 // 16kHz – standard for Whisper

export class AudioStreamManager {
  private _stream: MediaStream | null = null
  private _audioCtx: AudioContext | null = null
  private _analyser: AnalyserNode | null = null
  private _scriptNode: ScriptProcessorNode | null = null
  private _isDirectAudioMode = false
  private _isMuted = false
  private _started = false

  // STT mode buffers
  private _pcmBuffer: Float32Array[] = []
  private _silenceStart: number | null = null

  // Direct-audio mode chunk timer
  private _chunkBuffer: Float32Array[] = []
  private _chunkIntervalId: ReturnType<typeof setInterval> | null = null

  // Simple typed event emitter
  private _listeners: { [K in EventName]?: AudioEventMap[K][] } = {}

  // ── Public API ─────────────────────────────────────────────────────────────

  on<K extends EventName>(event: K, listener: AudioEventMap[K]): this {
    if (!this._listeners[event]) this._listeners[event] = []
    ;(this._listeners[event] as AudioEventMap[K][]).push(listener)
    return this
  }

  off<K extends EventName>(event: K, listener: AudioEventMap[K]): this {
    if (!this._listeners[event]) return this
    this._listeners[event] = (this._listeners[event] as AudioEventMap[K][]).filter(
      (l) => l !== listener
    ) as typeof this._listeners[K]
    return this
  }

  async start(isDirectAudioMode = false): Promise<void> {
    if (this._started) return
    this._isDirectAudioMode = isDirectAudioMode

    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    })

    this._audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
    const source = this._audioCtx.createMediaStreamSource(this._stream)

    // Analyser for volume level
    this._analyser = this._audioCtx.createAnalyser()
    this._analyser.fftSize = 256
    source.connect(this._analyser)

    // ScriptProcessorNode for capturing raw PCM (4096 samples ≈ 256ms at 16kHz)
    // Note: ScriptProcessorNode is deprecated but remains widely supported; AudioWorklet
    // would require a bundled worklet file which adds build complexity.
    this._scriptNode = this._audioCtx.createScriptProcessor(4096, 1, 1)
    this._scriptNode.onaudioprocess = this._onAudioProcess.bind(this)
    source.connect(this._scriptNode)
    this._scriptNode.connect(this._audioCtx.destination)

    if (isDirectAudioMode) {
      this._chunkIntervalId = setInterval(() => this._flushChunk(), CHUNK_INTERVAL_MS)
    }

    this._started = true
  }

  stop(): void {
    if (!this._started) return
    this._started = false

    if (this._chunkIntervalId !== null) {
      clearInterval(this._chunkIntervalId)
      this._chunkIntervalId = null
    }
    if (this._scriptNode) {
      this._scriptNode.disconnect()
      this._scriptNode = null
    }
    if (this._analyser) {
      this._analyser.disconnect()
      this._analyser = null
    }
    if (this._audioCtx) {
      this._audioCtx.close()
      this._audioCtx = null
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop())
      this._stream = null
    }
    this._pcmBuffer = []
    this._chunkBuffer = []
    this._silenceStart = null
  }

  mute(): void {
    this._isMuted = true
  }

  unmute(): void {
    this._isMuted = false
  }

  get isMuted(): boolean {
    return this._isMuted
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _onAudioProcess(e: AudioProcessingEvent): void {
    const pcm = e.inputBuffer.getChannelData(0)

    // Volume level (RMS)
    const rms = Math.sqrt(pcm.reduce((s, v) => s + v * v, 0) / pcm.length)
    this._emit('volumeLevel', Math.min(rms * 8, 1)) // scale 0–1

    if (this._isMuted) return

    const chunk = new Float32Array(pcm)

    if (this._isDirectAudioMode) {
      this._chunkBuffer.push(chunk)
      return
    }

    // STT mode: VAD with silence detection
    this._pcmBuffer.push(chunk)

    if (rms < SILENCE_THRESHOLD) {
      if (this._silenceStart === null) {
        this._silenceStart = Date.now()
      } else if (Date.now() - this._silenceStart >= SILENCE_GAP_MS) {
        // Only emit if we actually captured some speech
        const totalSamples = this._pcmBuffer.reduce((s, b) => s + b.length, 0)
        if (totalSamples > SAMPLE_RATE * 0.3) {
          // at least 300ms of audio
          this._flushUtterance()
        } else {
          this._pcmBuffer = []
        }
        this._silenceStart = null
      }
    } else {
      this._silenceStart = null
    }
  }

  private _flushUtterance(): void {
    const combined = _mergePcm(this._pcmBuffer)
    this._pcmBuffer = []
    const base64 = _pcmToWavBase64(combined, SAMPLE_RATE)
    this._emit('utterance', base64, 'wav')
  }

  private _flushChunk(): void {
    if (this._chunkBuffer.length === 0) return
    const combined = _mergePcm(this._chunkBuffer)
    this._chunkBuffer = []
    const base64 = _pcmToWavBase64(combined, SAMPLE_RATE)
    this._emit('audioChunk', base64, 'wav')
  }

  private _emit<K extends EventName>(event: K, ...args: Parameters<AudioEventMap[K]>): void {
    const listeners = this._listeners[event]
    if (!listeners) return
    for (const l of listeners) {
      ;(l as (...a: Parameters<AudioEventMap[K]>) => void)(...args)
    }
  }
}

// ── PCM helpers ───────────────────────────────────────────────────────────────

function _mergePcm(buffers: Float32Array[]): Float32Array {
  const total = buffers.reduce((s, b) => s + b.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const b of buffers) {
    out.set(b, offset)
    offset += b.length
  }
  return out
}

/**
 * Encode Float32 PCM to a 16-bit WAV and return as base64 string.
 * Produces a valid WAV header followed by little-endian int16 samples.
 */
function _pcmToWavBase64(pcm: Float32Array, sampleRate: number): string {
  const numSamples = pcm.length
  const bitsPerSample = 16
  const numChannels = 1
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const dataSize = numSamples * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  _writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  _writeString(view, 8, 'WAVE')
  _writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  _writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // PCM samples – clamp and convert Float32 → Int16
  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  // ArrayBuffer → base64
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function _writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
