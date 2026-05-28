import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

export type SidebarMode = 'chat' | 'agents'

type SidebarModeState = {
  mode: SidebarMode
  setMode: (mode: SidebarMode) => void
}

export const useSidebarMode = create<SidebarModeState>()(
  persist(
    (set) => ({
      mode: 'chat',
      setMode: (mode) => set({ mode }),
    }),
    {
      name: localStorageKey.sidebarMode,
      storage: createJSONStorage(() => localStorage),
    }
  )
)
