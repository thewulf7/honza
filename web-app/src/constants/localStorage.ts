export const localStorageKey = {
  LeftPanel: 'left-panel',
  threads: 'threads',
  messages: 'messages',
  theme: 'theme',
  modelProvider: 'model-provider',
  modelSources: 'model-sources',
  modelScores: 'model-scores',
  settingInterface: 'setting-appearance',
  settingGeneral: 'setting-general',
  settingCodeBlock: 'setting-code-block',
  settingLocalApiServer: 'setting-local-api-server',
  settingProxyConfig: 'setting-proxy-config',
  settingHardware: 'setting-hardware',
  settingVulkan: 'setting-vulkan',
  productAnalyticPrompt: 'productAnalyticPrompt',
  productAnalytic: 'productAnalytic',
  toolApproval: 'tool-approval',
  toolAvailability: 'tool-availability',
  mcpGlobalPermissions: 'mcp-global-permissions',
  lastUsedModel: 'last-used-model',
  lastUsedAgent: 'last-used-agent',
  agentWorkingDirectory: 'agent-working-directory',
  lastUsedAssistant: 'last-used-assistant',
  defaultAssistantId: 'default-assistant-id',
  favoriteModels: 'favorite-models',
  setupCompleted: 'setup-completed',
  threadManagement: 'thread-management',
  modelSupportCache: 'jan_model_support_cache',
  recentSearches: 'recent-searches',
  janModelPromptDismissed: 'jan-model-prompt-dismissed',
  agentMode: 'agent-mode',
  sidebarMode: 'sidebar-mode',
  latestJanModel: 'latest-jan-model',
  defaultEmbeddingModel: 'default-embedding-model',
  pausedDownloads: 'paused-downloads',
  discoverCache: 'discover-cache',
}

export const CACHE_EXPIRY_MS = 1000 * 60 * 60 * 24

export const getLastUsedAgent = (): string => {
  try {
    return localStorage.getItem(localStorageKey.lastUsedAgent) ?? 'codex'
  } catch {
    return 'codex'
  }
}

export const setLastUsedAgent = (agentId: string): void => {
  try {
    localStorage.setItem(localStorageKey.lastUsedAgent, agentId)
  } catch {
    // ignore storage errors
  }
}
