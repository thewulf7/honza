/**
 * useVoiceCall
 *
 * Orchestrates the full voice-call pipeline:
 *   1. Detects whether the active model supports direct audio input
 *   2. Starts AudioStreamManager for mic capture
 *   3. In STT mode: utterances → VoiceExtension.transcribe() → sendMessage()
 *   4. In direct mode: audio chunks → sendMessage() with InputAudio content part
 *   5. Watches for new assistant messages → VoiceExtension.synthesize() → TtsPlayer
 *   6. TtsPlayer phoneme events → voice-call-store (drives VRM lip-sync)
 *
 * Usage: mount inside the thread route and pass `sendMessage` + `messages`.
 */

import { useCallback, useEffect, useRef } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { ExtensionTypeEnum } from '@janhq/core'
import type { VoiceExtension } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { useVoiceCallStore } from '@/stores/voice-call-store'
import { useModelProvider } from '@/hooks/useModelProvider'
import { AudioStreamManager } from '@/services/audio/AudioStreamManager'
import { TtsPlayer } from '@/services/audio/TtsPlayer'
import { canModelDoDirectAudio } from '@/services/audio/ModelAudioCapabilityChecker'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'

type SendMessageFn = (options: {
  parts: Array<{ type: string; [key: string]: unknown }>
  id?: string
}) => void

interface UseVoiceCallOptions {
  sendMessage: SendMessageFn
  messages: UIMessage[]
  /** True while the LLM is streaming a response — synthesis waits until done. */
  isStreaming: boolean
}

export function useVoiceCall({ sendMessage, messages, isStreaming }: UseVoiceCallOptions) {
  const {
    status,
    isMuted,
    setStatus,
    setMuted,
    setSTTMode,
    setPhoneme,
    addTranscriptEntry,
    resetTranscript,
    setConnectingMessage,
  } = useVoiceCallStore()

  const navigate = useNavigate()
  const selectedModel = useModelProvider((state) => state.selectedModel)

  // Stable refs so callbacks always see the latest values without re-mounting effects
  const audioManagerRef = useRef<AudioStreamManager | null>(null)
  const ttsPlayerRef = useRef<TtsPlayer | null>(null)
  const messagesRef = useRef<UIMessage[]>(messages)
  const lastSynthesizedIdRef = useRef<string | null>(null)
  const sendMessageRef = useRef<SendMessageFn>(sendMessage)
  // Index of messages array length when the call started — only synthesize newer messages
  const callStartMessageIndexRef = useRef<number>(0)

  // Keep refs current
  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])

  // ── Watch for new assistant messages and synthesize them ──────────────────
  useEffect(() => {
    if (status === 'idle' || status === 'ending') return
    // Wait until the LLM finishes streaming before sending to TTS
    if (isStreaming) return

    const lastMsg = messages[messages.length - 1]
    if (!lastMsg || lastMsg.role !== 'assistant') return
    if (lastMsg.id === lastSynthesizedIdRef.current) return
    // Skip messages that existed before this call started
    if (messages.length <= callStartMessageIndexRef.current) return

    const ext = ExtensionManager.getInstance().get<VoiceExtension>(
      ExtensionTypeEnum.Voice
    )
    if (!ext) return

    // Guard: don't attempt synthesis if TTS server isn't ready
    ext.isTTSReady().then((ready) => {
      if (!ready) return

      lastSynthesizedIdRef.current = lastMsg.id

      const text = lastMsg.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { type: 'text'; text: string }).text)
        .join('')

      if (!text.trim()) return

      addTranscriptEntry('assistant', text)

      ext.synthesize(text).then((result) => {
        ttsPlayerRef.current?.enqueue({
          audioBase64: result.audioBase64,
          phonemes: result.phonemes,
          durationMs: result.durationMs,
        })
      }).catch((err) => console.error('[useVoiceCall] TTS error', err))
    })
  }, [messages, status, isStreaming, addTranscriptEntry])

  // ── Start call ────────────────────────────────────────────────────────────
  const startCall = useCallback(async () => {
    if (status !== 'idle') return

    setStatus('connecting')
    resetTranscript()
    // Snapshot message count so we only synthesize messages that arrive during this call
    callStartMessageIndexRef.current = messagesRef.current.length
    lastSynthesizedIdRef.current = null

    const ext = ExtensionManager.getInstance().get<VoiceExtension>(
      ExtensionTypeEnum.Voice
    )
    if (!ext) {
      console.error('[useVoiceCall] VoiceExtension not found')
      setStatus('idle')
      return
    }

    try {
      // Subscribe to live log events from whisper/kokoro and surface them in the UI
      setConnectingMessage('Starting STT server…')
      const unlisten = await listen<{ stage: string; message: string }>(
        'voice-progress',
        (event) => setConnectingMessage(event.payload.message)
      )
      try {
        await ext.startServers()
      } finally {
        unlisten()
        setConnectingMessage('')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[useVoiceCall] Failed to start voice servers', msg)
      toast.error('Voice setup failed — binaries missing', {
        description: msg,
        duration: 10000,
        action: {
          label: 'Download',
          onClick: () => navigate({ to: route.settings.voice }),
        },
      })
      setStatus('idle')
      return
    }

    const isDirectAudio = canModelDoDirectAudio(selectedModel)
    setSTTMode(!isDirectAudio)

    // Set up TTS player
    const ttsPlayer = new TtsPlayer()
    ttsPlayerRef.current = ttsPlayer
    ttsPlayer.on('phoneme', (phoneme, weight) => setPhoneme(phoneme, weight))
    ttsPlayer.on('playbackEnd', () => setPhoneme('', 0))

    // Set up audio capture
    const audioManager = new AudioStreamManager()
    audioManagerRef.current = audioManager

    if (isDirectAudio) {
      // Direct audio mode: stream chunks to the LLM
      audioManager.on('audioChunk', (audioBase64, format) => {
        sendMessageRef.current({
          parts: [
            {
              type: 'file',
              mediaType: `audio/${format}`,
              url: `data:audio/${format};base64,${audioBase64}`,
            },
          ],
        })
      })
    } else {
      // STT mode: transcribe utterances and send as text
      audioManager.on('utterance', async (audioBase64, format) => {
        try {
          const text = await ext.transcribe(audioBase64, format)
          if (!text.trim()) return
          addTranscriptEntry('user', text)
          sendMessageRef.current({
            parts: [{ type: 'text', text }],
          })
        } catch (err) {
          console.error('[useVoiceCall] STT error', err)
        }
      })
    }

    try {
      await audioManager.start(isDirectAudio)
      setStatus('active')
    } catch (err) {
      console.error('[useVoiceCall] Mic access denied', err)
      audioManager.stop()
      ttsPlayer.cancel()
      audioManagerRef.current = null
      ttsPlayerRef.current = null
      ext.stopServers().catch(() => {})
      setStatus('idle')
    }
  }, [status, selectedModel, setStatus, setSTTMode, setPhoneme, resetTranscript, addTranscriptEntry])

  // ── End call ──────────────────────────────────────────────────────────────
  const endCall = useCallback(() => {
    setStatus('ending')

    audioManagerRef.current?.stop()
    audioManagerRef.current = null

    ttsPlayerRef.current?.cancel()
    ttsPlayerRef.current = null

    setPhoneme('', 0)

    const ext = ExtensionManager.getInstance().get<VoiceExtension>(
      ExtensionTypeEnum.Voice
    )
    ext?.stopServers().catch(() => {})

    lastSynthesizedIdRef.current = null
    setStatus('idle')
  }, [setStatus, setPhoneme])

  // ── Mute / unmute ─────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const newMuted = !isMuted
    setMuted(newMuted)
    if (newMuted) {
      audioManagerRef.current?.mute()
    } else {
      audioManagerRef.current?.unmute()
    }
  }, [isMuted, setMuted])

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      audioManagerRef.current?.stop()
      ttsPlayerRef.current?.cancel()
    }
  }, [])

  return { startCall, endCall, toggleMute }
}
