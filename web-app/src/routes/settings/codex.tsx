import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { IconTerminal2, IconRobot } from '@tabler/icons-react'
import { toast } from 'sonner'

import { route } from '@/constants/routes'
import IntegrationModelSelector from '@/containers/IntegrationModelSelector'
import JanCodeRecommendation from '@/containers/JanCodeRecommendation'
import SettingsIntegrationPage from '@/containers/SettingsIntegrationPage'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useCodexSettings } from '@/hooks/useCodexSettings'
import { useMCPServers } from '@/hooks/useMCPServers'
import { getModelToStart } from '@/utils/getModelToStart'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.codex as any)({
  component: CodexIntegration,
})

function CodexIntegration() {
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const {
    corsEnabled,
    verboseLogs,
    serverHost,
    serverPort,
    setServerPort,
    apiPrefix,
    apiKey,
    trustedHosts,
    proxyTimeout,
    setLastServerModels,
  } = useLocalApiServer()
  const { serverStatus, setServerStatus } = useAppState()
  const { providers, selectedModel, selectedProvider, getProviderByName } =
    useModelProvider()
  const setActiveModels = useAppState((state) => state.setActiveModels)
  const { settings, setModel, setMcpServerNames, clearSettings } = useCodexSettings()
  const { mcpServers } = useMCPServers()
  const [isSaving, setIsSaving] = useState(false)

  const ensureServerReady = async (): Promise<string | null> => {
    const fallbackModel = getModelToStart({
      selectedModel,
      selectedProvider,
      getProviderByName,
    })?.model
    const targetModel = settings.model ?? fallbackModel ?? null

    const loadedModels = (await serviceHub.models().getActiveModels()) || []
    if (targetModel && !loadedModels.includes(targetModel)) {
      const providerWithModel = providers.find((provider) =>
        provider.models.some((model) => model.id === targetModel)
      )

      if (providerWithModel) {
        await serviceHub.models().startModel(providerWithModel, targetModel, true)
        await serviceHub
          .models()
          .getActiveModels()
          .then((models) => setActiveModels(models || []))
      }
    }

    let actualPort: number | undefined
    try {
      actualPort = await window.core?.api?.startServer({
        host: serverHost,
        port: serverPort,
        prefix: apiPrefix,
        apiKey,
        trustedHosts,
        isCorsEnabled: corsEnabled,
        isVerboseEnabled: verboseLogs,
        proxyTimeout,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('already running')) throw error
    }

    if (actualPort && actualPort !== serverPort) {
      setServerPort(actualPort)
    }
    setServerStatus('running')

    const activeModels = await serviceHub.models().getActiveModels().catch(() => [] as string[])
    if (activeModels.length > 0) {
      const serverModels = activeModels.flatMap((id) => {
        const provider = providers.find((item) => item?.models?.some((model) => model.id === id))
        return provider ? [{ model: id, provider: provider.provider }] : []
      })
      if (serverModels.length > 0) setLastServerModels(serverModels)
    }

    return targetModel
  }

  const handleSave = async () => {
    try {
      setIsSaving(true)
      if (serverStatus === 'stopped') {
        toast.info('Starting server...', {
          description: 'Preparing server for Codex',
        })
      }

      const targetModel = await ensureServerReady()
      const modelObj = providers
        .flatMap((p) => p.models)
        .find((m) => m.id === targetModel)
      const ctxSetting = modelObj?.settings?.['max_context_tokens']?.controller_props?.value
      const contextWindow = typeof ctxSetting === 'number' && ctxSetting > 0 ? ctxSetting : null

      // Collect active MCP servers from Jan to forward to Codex.
      // Env variable *values* are intentionally omitted — Codex's RawMcpServerConfig
      // does not support key=value env entries; only env var *names* (as references) are allowed.
      const mcpServersToSync: Record<string, Record<string, unknown>> = {}
      const syncedMcpNames: string[] = []
      for (const [name, cfg] of Object.entries(mcpServers)) {
        if (cfg.active === false) continue
        const entry: Record<string, unknown> = {}
        if (cfg.command) entry.command = cfg.command
        if (cfg.args?.length) entry.args = cfg.args
        if (cfg.url) entry.url = cfg.url
        // Only include entries that have enough data to be usable by Codex
        if (entry.command || entry.url) {
          mcpServersToSync[name] = entry
          syncedMcpNames.push(name)
        }
      }

      await invoke('write_codex_config', {
        baseUrl: `http://${serverHost}:${serverPort}${apiPrefix}`,
        apiKey: apiKey || null,
        model: targetModel,
        contextWindow,
        mcpServers: mcpServersToSync,
        prevMcpServerNames: settings.mcpServerNames,
      })
      if (!settings.model && targetModel) {
        setModel(targetModel)
      }
      setMcpServerNames(syncedMcpNames)
      toast.success('Codex configured to use Jan via its user config.toml')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to update Codex config', {
        description: message,
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = async () => {
    try {
      await invoke('clear_codex_config', {
        model: settings.model,
        mcpServerNames: settings.mcpServerNames,
      })
      clearSettings()
      toast.success('Codex settings cleared')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to clear Codex config', {
        description: message,
      })
    }
  }

  return (
    <SettingsIntegrationPage>
      <Card
        header={
          <div className="mb-3 flex w-full items-center gap-3">
            <div className="flex h-5 w-5 items-center justify-center rounded-sm border border-border/60 bg-secondary/40 shrink-0">
              <IconTerminal2 size={13} className="text-foreground" />
            </div>
            <h1 className="text-foreground font-studio font-medium text-base">
              Codex integration
            </h1>
          </div>
        }
      >
        <CardItem
          title="Model"
          description="Codex"
          actions={
            <IntegrationModelSelector
              providers={providers}
              selectedModel={settings.model}
              onSelect={setModel}
              placeholder="Select Model"
              allowEmptyOption
              filterModel={(model) => model.isLocal === true}
              showSize
            />
          }
          descriptionOutside={
            <div className="flex flex-col gap-2">
              <JanCodeRecommendation
                selectedModel={settings.model}
                onSelect={setModel}
              />
            </div>
          }
        />
        <div className="flex mt-2 justify-end gap-2 border-t pt-4">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => navigate({ to: route.codexAgent })}
            >
              <IconRobot size={14} />
              Run Agent
            </Button>
            <Button size="sm" variant="outline" onClick={handleReset}>
              Reset
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save & Enable'}
            </Button>
          </div>
        </div>
      </Card>
    </SettingsIntegrationPage>
  )
}