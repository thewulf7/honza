import React, { useRef } from 'react'
import { PhoneOff, Mic, MicOff, Video, VideoOff } from 'lucide-react'
import { VrmViewer, type VrmViewerHandle } from '@/components/vrm/VrmViewer'
import { LocalCameraPreview } from '@/components/vrm/LocalCameraPreview'
import { WaveformVisualizer } from '@/components/WaveformVisualizer'
import { VoiceCallBackground } from '@/components/vrm/VoiceCallBackground'
import { useVoiceCallStore } from '@/stores/voice-call-store'

interface VoiceCallOverlayProps {
  endCall: () => void
  toggleMute: () => void
}

/**
 * Full-viewport voice call overlay, similar to a Skype/FaceTime call screen.
 *
 * Layout:
 *  ┌──────────────────────────────────────────────┐
 *  │  VRM avatar (center)         [Camera PiP] ↗  │
 *  │                                               │
 *  │  Transcript chips                             │
 *  │  ──────────────────────────────────────────  │
 *  │  [Waveform]  [Mute]  [Camera]  [End Call]     │
 *  └──────────────────────────────────────────────┘
 */
export function VoiceCallOverlay({ endCall, toggleMute }: VoiceCallOverlayProps) {
  const status = useVoiceCallStore((s) => s.status)
  const isMuted = useVoiceCallStore((s) => s.isMuted)
  const isCameraEnabled = useVoiceCallStore((s) => s.isCameraEnabled)
  const vrmPath = useVoiceCallStore((s) => s.vrmPath)
  const transcript = useVoiceCallStore((s) => s.transcript)
  const currentPhoneme = useVoiceCallStore((s) => s.currentPhoneme)
  const setCameraEnabled = useVoiceCallStore((s) => s.setCameraEnabled)
  const connectingMessage = useVoiceCallStore((s) => s.connectingMessage)

  // Volume level subscribed separately to avoid re-renders on every audio frame
  const volumeLevel = useVoiceCallStore((s) =>
    s.currentPhoneme ? 0.4 : 0.05
  )

  const vrmRef = useRef<VrmViewerHandle>(null)

  // Keep VRM ref in sync with phoneme from store
  React.useEffect(() => {
    if (currentPhoneme) {
      vrmRef.current?.setPhoneme(currentPhoneme.phoneme, currentPhoneme.weight)
    } else {
      vrmRef.current?.resetMouth()
    }
  }, [currentPhoneme])

  if (status === 'idle') return null

  const isConnecting = status === 'connecting'

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{ fontFamily: 'inherit' }}
    >
      {/* ── Animated background ──────────────────────────────────────────── */}
      <VoiceCallBackground />
      {/* ── Local camera PiP (top-right) ─────────────────────────────────── */}
      <div className="absolute right-4 top-4 z-10">
        <LocalCameraPreview enabled={isCameraEnabled} className="ring-1 ring-white/10" />
      </div>

      {/* ── VRM avatar (center) ───────────────────────────────────────────── */}
      <div className="relative z-10 flex flex-1 items-center justify-center">
        {isConnecting && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white" />
            <span className="text-sm text-white/60">
              {connectingMessage || 'Connecting\u2026'}
            </span>
          </div>
        )}
        {vrmPath ? (
          <VrmViewer
            ref={vrmRef}
            vrmPath={vrmPath}
            className={isConnecting ? 'opacity-30' : 'opacity-100'}
            style={{ width: '100%', height: '100%', transition: 'opacity 0.3s' } as React.CSSProperties}
          />
        ) : (
          /* Placeholder when no VRM is configured */
          <div className={`flex flex-col items-center gap-4 transition-opacity ${isConnecting ? 'opacity-30' : 'opacity-100'}`}>
            <div className="flex h-40 w-40 items-center justify-center rounded-full bg-white/10 ring-2 ring-white/20">
              <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="40" cy="28" r="18" fill="rgba(255,255,255,0.2)" />
                <path d="M8 72c0-17.673 14.327-32 32-32s32 14.327 32 32" fill="rgba(255,255,255,0.15)" />
              </svg>
            </div>
            <span className="text-sm text-white/40">No avatar configured</span>
          </div>
        )}
      </div>

      {/* ── Transcript chips ──────────────────────────────────────────────── */}
      {transcript.length > 0 && (
        <div className="relative z-10 mx-auto mb-2 flex max-h-32 w-full max-w-lg flex-col gap-1 overflow-y-auto px-4">
          {transcript.slice(-5).map((entry, i) => (
            <div
              key={i}
              className={`flex ${entry.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <span
                className={`rounded-full px-3 py-1 text-sm ${
                  entry.role === 'user'
                    ? 'bg-white/15 text-white'
                    : 'bg-indigo-500/30 text-indigo-100'
                }`}
              >
                {entry.text}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Controls bar ─────────────────────────────────────────────────── */}
      <div className="relative z-10 flex items-center justify-center gap-4 border-t border-white/10 px-6 py-4 backdrop-blur-sm">
        {/* Waveform */}
        <WaveformVisualizer
          volumeLevel={volumeLevel}
          active={status === 'active' && !isMuted}
          className="text-white/70"
        />

        {/* Mute */}
        <button
          onClick={toggleMute}
          className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
            isMuted ? 'bg-red-500/80 hover:bg-red-500' : 'bg-white/15 hover:bg-white/25'
          }`}
          title={isMuted ? 'Unmute' : 'Mute'}
        >
          {isMuted ? <MicOff size={20} className="text-white" /> : <Mic size={20} className="text-white" />}
        </button>

        {/* Camera toggle */}
        <button
          onClick={() => setCameraEnabled(!isCameraEnabled)}
          className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
            !isCameraEnabled ? 'bg-red-500/80 hover:bg-red-500' : 'bg-white/15 hover:bg-white/25'
          }`}
          title={isCameraEnabled ? 'Turn off camera' : 'Turn on camera'}
        >
          {isCameraEnabled
            ? <Video size={20} className="text-white" />
            : <VideoOff size={20} className="text-white" />}
        </button>

        {/* End call */}
        <button
          onClick={endCall}
          className="flex h-14 w-14 items-center justify-center rounded-full bg-red-600 shadow-lg transition-colors hover:bg-red-700"
          title="End call"
        >
          <PhoneOff size={22} className="text-white" />
        </button>
      </div>
    </div>
  )
}
