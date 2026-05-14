import type { Model } from '../../../types/modelProviders'

/**
 * Checks whether the active model supports direct audio input (i.e., the
 * model can receive raw audio chunks instead of transcribed text).
 *
 * Uses the `AUDIO_TO_TEXT` capability string from ModelCapabilities.
 */
export function canModelDoDirectAudio(model: Model | null | undefined): boolean {
  if (!model) return false
  return model.capabilities?.includes('audio_to_text') ?? false
}
