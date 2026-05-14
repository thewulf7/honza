/**
 * Types for voice call / audio streaming features.
 * @module
 */

/** A single phoneme event with timing, used to drive VRM lip-sync. */
export interface PhonemeTimestamp {
  /** ARPAbet or CMU phoneme string, e.g. "AA", "IY", "UW", "EH", "OW", silence = "" */
  phoneme: string
  startMs: number
  endMs: number
}

/** Status of the active voice call session. */
export type VoiceCallStatus = 'idle' | 'connecting' | 'active' | 'muted' | 'ending'

/** Result returned by a TTS synthesize() call. */
export interface SpeechSynthesisResult {
  /** Base64-encoded WAV audio data */
  audioBase64: string
  format: 'wav'
  /** Optional phoneme timestamps for lip-sync. If absent, caller must derive timing. */
  phonemes?: PhonemeTimestamp[]
  /** Total audio duration in milliseconds */
  durationMs?: number
}
