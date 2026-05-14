import { create } from 'zustand'
import type { VoiceCallStatus, PhonemeTimestamp } from '@janhq/core'

interface CurrentPhoneme {
  phoneme: string
  weight: number
}

interface VoiceCallState {
  status: VoiceCallStatus
  isMuted: boolean
  isCameraEnabled: boolean
  isSTTMode: boolean
  vrmPath: string
  currentPhoneme: CurrentPhoneme | null
  // Transcript shown in overlay (last N exchanges)
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>
  // Live progress message shown while servers are starting
  connectingMessage: string

  setStatus: (status: VoiceCallStatus) => void
  setMuted: (muted: boolean) => void
  setCameraEnabled: (enabled: boolean) => void
  setSTTMode: (isSTTMode: boolean) => void
  setVrmPath: (path: string) => void
  setPhoneme: (phoneme: string, weight: number) => void
  addTranscriptEntry: (role: 'user' | 'assistant', text: string) => void
  resetTranscript: () => void
  setConnectingMessage: (msg: string) => void
}

const DEFAULT_VRM_PATH = '' // Set to a VRM file URL when available
const MAX_TRANSCRIPT_ENTRIES = 10

export const useVoiceCallStore = create<VoiceCallState>()((set) => ({
  status: 'idle',
  isMuted: false,
  isCameraEnabled: true,
  isSTTMode: true,
  vrmPath: DEFAULT_VRM_PATH,
  currentPhoneme: null,
  transcript: [],
  connectingMessage: '',

  setStatus: (status) => set({ status }),
  setMuted: (isMuted) => set({ isMuted }),
  setCameraEnabled: (isCameraEnabled) => set({ isCameraEnabled }),
  setSTTMode: (isSTTMode) => set({ isSTTMode }),
  setVrmPath: (vrmPath) => set({ vrmPath }),
  setPhoneme: (phoneme, weight) => set({ currentPhoneme: { phoneme, weight } }),
  addTranscriptEntry: (role, text) =>
    set((state) => ({
      transcript: [
        ...state.transcript.slice(-(MAX_TRANSCRIPT_ENTRIES - 1)),
        { role, text },
      ],
    })),
  resetTranscript: () => set({ transcript: [] }),
  setConnectingMessage: (connectingMessage) => set({ connectingMessage }),
}))
