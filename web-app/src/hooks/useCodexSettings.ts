import { useCallback, useState } from 'react'

export interface CodexSettings {
  model: string | null
  /** Names of MCP servers that were last written to Codex's config.toml by Jan. */
  mcpServerNames: string[]
  /** Custom path to the codex binary (empty → use auto-detected / PATH). */
  binaryPath: string
  /** Custom path to config.toml (empty → use platform default ~/.codex/config.toml). */
  configFilePath: string
}

const STORAGE_KEY = 'codex-helper-settings'

const defaultSettings: CodexSettings = {
  model: null,
  mcpServerNames: [],
  binaryPath: '',
  configFilePath: '',
}

const loadFromStorage = (): CodexSettings => {
  if (typeof window === 'undefined') return defaultSettings

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (typeof parsed === 'object' && parsed !== null && 'model' in parsed) {
        return {
          model: parsed.model ?? null,
          mcpServerNames: Array.isArray(parsed.mcpServerNames) ? parsed.mcpServerNames : [],
          binaryPath: typeof parsed.binaryPath === 'string' ? parsed.binaryPath : '',
          configFilePath: typeof parsed.configFilePath === 'string' ? parsed.configFilePath : '',
        }
      }
    }
  } catch {
    console.warn('Failed to load codex helper settings from localStorage')
  }

  return defaultSettings
}

export function useCodexSettings() {
  const [settings, setSettings] = useState<CodexSettings>(loadFromStorage)

  const saveToStorage = useCallback((data: CodexSettings) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      console.warn('Failed to save codex helper settings to localStorage')
    }
  }, [])

  const setModel = useCallback((model: string | null) => {
    setSettings((prev) => {
      const next = { ...prev, model }
      saveToStorage(next)
      return next
    })
  }, [saveToStorage])

  const setMcpServerNames = useCallback((mcpServerNames: string[]) => {
    setSettings((prev) => {
      const next = { ...prev, mcpServerNames }
      saveToStorage(next)
      return next
    })
  }, [saveToStorage])

  const setBinaryPath = useCallback((binaryPath: string) => {
    setSettings((prev) => {
      const next = { ...prev, binaryPath }
      saveToStorage(next)
      return next
    })
  }, [saveToStorage])

  const setConfigFilePath = useCallback((configFilePath: string) => {
    setSettings((prev) => {
      const next = { ...prev, configFilePath }
      saveToStorage(next)
      return next
    })
  }, [saveToStorage])

  const clearSettings = useCallback(() => {
    setSettings(defaultSettings)
    saveToStorage(defaultSettings)
  }, [saveToStorage])

  return {
    settings,
    setModel,
    setMcpServerNames,
    setBinaryPath,
    setConfigFilePath,
    clearSettings,
  }
}
