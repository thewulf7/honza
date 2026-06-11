import { localStorageKey } from '@/constants/localStorage'
import type { ModelInfo } from '@janhq/core'

export const getLastUsedModel = (): {
  provider: string
  model: string
} | null => {
  try {
    const stored = localStorage.getItem(localStorageKey.lastUsedModel)
    return stored ? JSON.parse(stored) : null
  } catch (error) {
    console.debug('Failed to get last used model from localStorage:', error)
    return null
  }
}

const LOCAL_PROVIDER_PRIORITY = ['llamacpp', 'mlx', 'mistralrs']

function firstLocalModel(
  getProviderByName: (name: string) => ModelProvider | undefined
): { model: string; provider: ModelProvider } | null {
  for (const name of LOCAL_PROVIDER_PRIORITY) {
    const p = getProviderByName(name)
    if (p?.models?.length) return { model: p.models[0].id, provider: p }
  }
  return null
}

// Helper function to determine which model to start
export const getModelToStart = (params: {
  selectedModel?: ModelInfo | null
  selectedProvider?: string | null
  getProviderByName: (name: string) => ModelProvider | undefined
}): { model: string; provider: ModelProvider } | null => {
  const { selectedModel, selectedProvider, getProviderByName } = params

  // Use last used model if it still exists
  const lastUsedModel = getLastUsedModel()
  if (lastUsedModel) {
    const provider = getProviderByName(lastUsedModel.provider)
    if (provider?.models.some((m) => m.id === lastUsedModel.model)) {
      return { model: lastUsedModel.model, provider }
    }
  }

  // Use selected model if available
  if (selectedModel && selectedProvider) {
    const provider = getProviderByName(selectedProvider)
    if (provider) {
      return { model: selectedModel.id, provider }
    }
  }

  // Fall back to first available local model (llamacpp, then mlx)
  return firstLocalModel(getProviderByName)
}
