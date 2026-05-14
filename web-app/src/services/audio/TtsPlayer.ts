/**
 * TtsPlayer
 *
 * Queue-based TTS audio player that:
 *  1. Accepts `SpeechSynthesisResult` items (WAV base64 + optional phoneme timestamps)
 *  2. Decodes and plays them sequentially via the Web Audio API
 *  3. Emits `phoneme` events timed to the playback position (for VRM lip-sync)
 *  4. Emits `playbackEnd` when the queue drains
 */

import type { PhonemeTimestamp } from '@janhq/core'

type TtsEventMap = {
  phoneme: (phoneme: string, weight: number) => void
  playbackEnd: () => void
}

type TtsEventName = keyof TtsEventMap

export interface TtsItem {
  audioBase64: string
  phonemes?: PhonemeTimestamp[]
  durationMs?: number
}

// Weight lookup for ARPAbet phonemes → VRM expression weights
const PHONEME_WEIGHT: Record<string, number> = {
  AA: 0.8,
  AE: 0.6,
  AH: 0.5,
  AO: 0.7,
  AW: 0.7,
  AY: 0.6,
  EH: 0.6,
  ER: 0.5,
  EY: 0.6,
  IH: 0.6,
  IY: 0.7,
  OW: 0.7,
  OY: 0.7,
  UH: 0.6,
  UW: 0.7,
  '': 0, // silence
}

export class TtsPlayer {
  private _ctx: AudioContext | null = null
  private _queue: TtsItem[] = []
  private _playing = false
  private _cancelled = false
  private _listeners: { [K in TtsEventName]?: TtsEventMap[K][] } = {}

  // ── Public API ─────────────────────────────────────────────────────────────

  on<K extends TtsEventName>(event: K, listener: TtsEventMap[K]): this {
    if (!this._listeners[event]) this._listeners[event] = []
    ;(this._listeners[event] as TtsEventMap[K][]).push(listener)
    return this
  }

  off<K extends TtsEventName>(event: K, listener: TtsEventMap[K]): this {
    if (!this._listeners[event]) return this
    this._listeners[event] = (this._listeners[event] as TtsEventMap[K][]).filter(
      (l) => l !== listener
    ) as typeof this._listeners[K]
    return this
  }

  enqueue(item: TtsItem): void {
    this._cancelled = false
    this._queue.push(item)
    if (!this._playing) {
      this._playNext()
    }
  }

  cancel(): void {
    this._cancelled = true
    this._queue = []
    this._playing = false
    this._emit('phoneme', '', 0) // reset mouth
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _getCtx(): AudioContext {
    if (!this._ctx || this._ctx.state === 'closed') {
      this._ctx = new AudioContext()
    }
    return this._ctx
  }

  private async _playNext(): Promise<void> {
    if (this._cancelled || this._queue.length === 0) {
      this._playing = false
      this._emit('playbackEnd')
      return
    }

    this._playing = true
    const item = this._queue.shift()!
    const ctx = this._getCtx()

    // WebView2 (and browsers) start AudioContext suspended until a resume() call.
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    try {
      // Decode base64 → ArrayBuffer
      const binary = atob(item.audioBase64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

      const audioBuffer = await ctx.decodeAudioData(bytes.buffer)
      if (this._cancelled) {
        this._playing = false
        return
      }

      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)

      const startTime = ctx.currentTime
      const durationSec = audioBuffer.duration

      // Schedule phoneme events
      const phonemes = item.phonemes ?? _derivePhonemes(durationSec * 1000)
      this._schedulePhonemes(ctx, startTime, phonemes)

      source.onended = () => {
        if (this._cancelled) return
        this._emit('phoneme', '', 0) // close mouth after utterance
        this._playNext()
      }

      source.start(startTime)
    } catch (err) {
      console.error('[TtsPlayer] Playback error', err)
      this._playNext() // skip broken item
    }
  }

  private _schedulePhonemes(
    ctx: AudioContext,
    startTime: number,
    phonemes: PhonemeTimestamp[]
  ): void {
    for (const p of phonemes) {
      const delay = p.startMs / 1000
      const weight = PHONEME_WEIGHT[p.phoneme.toUpperCase()] ?? 0.5
      // Use setTimeout with AudioContext time offset for accuracy
      const fireAt = (startTime + delay - ctx.currentTime) * 1000
      if (fireAt < 0) continue
      setTimeout(() => {
        if (!this._cancelled) {
          this._emit('phoneme', p.phoneme, weight)
        }
      }, fireAt)
    }
  }

  private _emit<K extends TtsEventName>(event: K, ...args: Parameters<TtsEventMap[K]>): void {
    const listeners = this._listeners[event]
    if (!listeners) return
    for (const l of listeners) {
      ;(l as (...a: Parameters<TtsEventMap[K]>) => void)(...args)
    }
  }
}

/**
 * When the TTS backend does not return phoneme timestamps, derive a minimal
 * set by distributing common phonemes evenly across the audio duration.
 * This produces a rough mouth-open/close rhythm that looks natural.
 */
function _derivePhonemes(durationMs: number): PhonemeTimestamp[] {
  const syllableDuration = 120 // ~120ms per syllable
  const count = Math.max(1, Math.round(durationMs / syllableDuration))
  const vowels = ['AA', 'IY', 'UW', 'EH', 'OW']
  const result: PhonemeTimestamp[] = []

  for (let i = 0; i < count; i++) {
    const startMs = (durationMs / count) * i
    const endMs = startMs + syllableDuration * 0.6
    result.push({
      phoneme: vowels[i % vowels.length],
      startMs,
      endMs,
    })
    // Brief silence between syllables
    if (endMs < (durationMs / count) * (i + 1)) {
      result.push({ phoneme: '', startMs: endMs, endMs: (durationMs / count) * (i + 1) })
    }
  }
  return result
}
