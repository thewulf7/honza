import { useState, useCallback } from 'react'

const STORAGE_KEY = 'hermes-agent-settings'

export interface HermesSettings {
  /** Custom path to the `hermes` binary. Empty string → use PATH. */
  binaryPath: string
  /** Model override passed via `--model`. Empty string → Hermes default. */
  model: string
  /** Provider override passed via `--provider`. Empty string → Hermes default. */
  provider: string
  /** Model selected for the Jan bridge integration (written to config.yaml). */
  bridgeModel: string
}

const DEFAULT_SETTINGS: HermesSettings = {
  binaryPath: '',
  model: '',
  provider: '',
  bridgeModel: '',
}

function loadFromStorage(): HermesSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (typeof parsed === 'object' && parsed !== null) {
        return {
          binaryPath: typeof parsed.binaryPath === 'string' ? parsed.binaryPath : '',
          model: typeof parsed.model === 'string' ? parsed.model : '',
          provider: typeof parsed.provider === 'string' ? parsed.provider : '',
          bridgeModel: typeof parsed.bridgeModel === 'string' ? parsed.bridgeModel : '',
        }
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS
}

function saveToStorage(data: HermesSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // ignore
  }
}

export function useHermesSettings() {
  const [settings, setSettings] = useState<HermesSettings>(loadFromStorage)

  const setBinaryPath = useCallback((binaryPath: string) => {
    setSettings((prev) => {
      const next = { ...prev, binaryPath }
      saveToStorage(next)
      return next
    })
  }, [])

  const setModel = useCallback((model: string) => {
    setSettings((prev) => {
      const next = { ...prev, model }
      saveToStorage(next)
      return next
    })
  }, [])

  const setProvider = useCallback((provider: string) => {
    setSettings((prev) => {
      const next = { ...prev, provider }
      saveToStorage(next)
      return next
    })
  }, [])

  const setBridgeModel = useCallback((bridgeModel: string) => {
    setSettings((prev) => {
      const next = { ...prev, bridgeModel }
      saveToStorage(next)
      return next
    })
  }, [])

  const clearSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS)
    saveToStorage(DEFAULT_SETTINGS)
  }, [])

  return { settings, setBinaryPath, setModel, setProvider, setBridgeModel, clearSettings }
}
