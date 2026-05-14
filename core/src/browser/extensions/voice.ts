import { BaseExtension, ExtensionTypeEnum } from '../extension'
import type { SpeechSynthesisResult } from '../../types/audio'

/**
 * Abstract base class for voice call extensions.
 * Implementors provide local STT (speech-to-text) and TTS (text-to-speech) capabilities
 * by managing local model servers (e.g., Whisper.cpp for STT, Kokoro-ONNX for TTS).
 */
export abstract class VoiceExtension extends BaseExtension {
  type(): ExtensionTypeEnum | undefined {
    return ExtensionTypeEnum.Voice
  }

  // ── STT ────────────────────────────────────────────────────────────────────

  /** Returns true when the STT server is ready to accept requests. */
  abstract isSTTReady(): Promise<boolean>

  /**
   * Transcribe audio to text.
   * @param audioBase64 Base64-encoded audio data.
   * @param format Audio format of the data.
   * @returns The transcribed text string.
   */
  abstract transcribe(
    audioBase64: string,
    format: 'mp3' | 'wav' | 'ogg' | 'flac'
  ): Promise<string>

  // ── TTS ────────────────────────────────────────────────────────────────────

  /** Returns true when the TTS server is ready to accept requests. */
  abstract isTTSReady(): Promise<boolean>

  /**
   * Synthesize speech from text.
   * @param text The text to speak.
   * @returns WAV audio as base64, optional phoneme timestamps for lip-sync.
   */
  abstract synthesize(text: string): Promise<SpeechSynthesisResult>

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start the underlying STT and TTS servers. Called when a voice call begins. */
  abstract startServers(): Promise<void>

  /** Stop the underlying servers. Called when a voice call ends. */
  abstract stopServers(): Promise<void>
}
