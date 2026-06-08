import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { IconCircleCheck, IconCircleX, IconRefresh, IconPlus, IconHandStop, IconTerminal2, IconAlertCircle } from '@tabler/icons-react'
import { toast } from 'sonner'

import { useTranslation } from '@/i18n/react-i18next-compat'
import IntegrationModelSelector from '@/containers/IntegrationModelSelector'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'
import JanCodeRecommendation from '@/containers/JanCodeRecommendation'
import SettingsIntegrationPage from '@/containers/SettingsIntegrationPage'
import { Card, CardItem } from '@/containers/Card'
import { ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useCodexSettings } from '@/hooks/useCodexSettings'
import { useHermesSettings } from '@/hooks/useHermesSettings'
import { useMCPServers } from '@/hooks/useMCPServers'
import { getModelToStart } from '@/utils/getModelToStart'
import { useClaudeCodeModel } from '@/hooks/useClaudeCodeModel'
import AddEditCustomCliDialog from '@/containers/dialogs/AddEditCustomCliDialog'

export function CodexAgentSettings() {
  const { t } = useTranslation('settings')
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
  const {
    settings,
    setModel,
    setMcpServerNames,
    clearSettings,
    setBinaryPath,
    setConfigFilePath,
  } = useCodexSettings()
  const { mcpServers } = useMCPServers()
  const [isSaving, setIsSaving] = useState(false)
  const [detectedBinary, setDetectedBinary] = useState<string | null | undefined>(undefined)
  const [isDetecting, setIsDetecting] = useState(false)
  const [formFields, setFormFields] = useState({
    model: '',
    model_provider: '',
    profile: '',
    model_reasoning_effort: '',
    model_context_window: '',
    model_auto_compact_token_limit: '',
    approval_policy: '',
    sandbox_mode: '',
    shell: '',
    history_max_context_tokens: '',
    disable_response_storage: null as boolean | null,
    notify_on_completion: null as boolean | null,
    hide_agent_reasoning: null as boolean | null,
    full_stdout: null as boolean | null,
    jan_profile_exists: false,
  })
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const configPathOverride = settings.configFilePath || null

  const runDetect = () => {
    setIsDetecting(true)
    invoke<string | null>('detect_codex_binary')
      .then((path) => setDetectedBinary(path))
      .catch(() => setDetectedBinary(null))
      .finally(() => setIsDetecting(false))
  }

  const loadFormFields = () => {
    invoke<Record<string, unknown>>('parse_codex_config_fields', { configPathOverride })
      .then((fields) => {
        setFormFields({
          model: (fields.model as string | null) ?? '',
          model_provider: (fields.model_provider as string | null) ?? '',
          profile: (fields.profile as string | null) ?? '',
          model_reasoning_effort: (fields.model_reasoning_effort as string | null) ?? '',
          model_context_window: fields.model_context_window != null ? String(fields.model_context_window) : '',
          model_auto_compact_token_limit: fields.model_auto_compact_token_limit != null ? String(fields.model_auto_compact_token_limit) : '',
          approval_policy: (fields.approval_policy as string | null) ?? '',
          sandbox_mode: (fields.sandbox_mode as string | null) ?? '',
          shell: (fields.shell as string | null) ?? '',
          history_max_context_tokens: fields.history_max_context_tokens != null ? String(fields.history_max_context_tokens) : '',
          disable_response_storage: (fields.disable_response_storage as boolean | null) ?? null,
          notify_on_completion: (fields.notify_on_completion as boolean | null) ?? null,
          hide_agent_reasoning: (fields.hide_agent_reasoning as boolean | null) ?? null,
          full_stdout: (fields.full_stdout as boolean | null) ?? null,
          jan_profile_exists: (fields.jan_profile_exists as boolean | null) ?? false,
        })
      })
      .catch(() => {})
  }

  useEffect(() => {
    loadFormFields()
    runDetect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const validateFormFields = (fields: typeof formFields): string[] => {
    const errors: string[] = []
    const positiveInt = (raw: string, label: string) => {
      if (!raw) return
      const n = parseInt(raw, 10)
      if (isNaN(n) || n <= 0) errors.push(`${label} must be a positive number`)
    }
    positiveInt(fields.model_context_window, 'Context Window')
    positiveInt(fields.model_auto_compact_token_limit, 'Auto-compact Token Limit')
    positiveInt(fields.history_max_context_tokens, 'History Context Tokens')
    if (fields.model_context_window && fields.model_auto_compact_token_limit) {
      const ctx = parseInt(fields.model_context_window, 10)
      const compact = parseInt(fields.model_auto_compact_token_limit, 10)
      if (!isNaN(ctx) && !isNaN(compact) && compact >= ctx) {
        errors.push('Auto-compact Token Limit must be less than Context Window')
      }
    }
    if (fields.shell && !fields.shell.startsWith('/')) {
      errors.push('Shell must be an absolute path (e.g. /bin/zsh)')
    }
    return errors
  }

  const saveFields = (fields: typeof formFields) => {
    if (validateFormFields(fields).length > 0) return
    const payload = {
      model: fields.model || null,
      model_provider: fields.model_provider || null,
      profile: fields.profile || null,
      model_reasoning_effort: fields.model_reasoning_effort || null,
      model_context_window: fields.model_context_window ? parseInt(fields.model_context_window, 10) : null,
      model_auto_compact_token_limit: fields.model_auto_compact_token_limit ? parseInt(fields.model_auto_compact_token_limit, 10) : null,
      approval_policy: fields.approval_policy || null,
      sandbox_mode: fields.sandbox_mode || null,
      shell: fields.shell || null,
      history_max_context_tokens: fields.history_max_context_tokens ? parseInt(fields.history_max_context_tokens, 10) : null,
      disable_response_storage: fields.disable_response_storage,
      notify_on_completion: fields.notify_on_completion,
      hide_agent_reasoning: fields.hide_agent_reasoning,
      full_stdout: fields.full_stdout,
      jan_profile_exists: fields.jan_profile_exists,
    }
    invoke('update_codex_config_fields', { fields: payload, configPathOverride })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        toast.error('Failed to save config.toml', { description: message })
      })
  }

  const setFormField = <K extends keyof typeof formFields>(key: K, val: (typeof formFields)[K]) => {
    const next = { ...formFields, [key]: val }
    setFormFields(next)
    if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current)
    saveDebounceRef.current = setTimeout(() => saveFields(next), 600)
  }

  const ensureServerReady = async (): Promise<string | null> => {
    const fallbackModel = getModelToStart({ selectedModel, selectedProvider, getProviderByName })?.model
    const targetModel = settings.model ?? fallbackModel ?? null
    const loadedModels = (await serviceHub.models().getActiveModels()) || []
    if (targetModel && !loadedModels.includes(targetModel)) {
      const providerWithModel = providers.find((provider) => provider.models.some((model) => model.id === targetModel))
      if (providerWithModel) {
        await serviceHub.models().startModel(providerWithModel, targetModel, true)
        await serviceHub.models().getActiveModels().then((models) => setActiveModels(models || []))
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
        toast.info('Starting server...', { description: 'Preparing server for Codex' })
      }
      const targetModel = await ensureServerReady()
      const modelObj = providers.flatMap((p) => p.models).find((m) => m.id === targetModel)
      const ctxSetting = modelObj?.settings?.['max_context_tokens']?.controller_props?.value
      const contextWindow = typeof ctxSetting === 'number' && ctxSetting > 0 ? ctxSetting : null
      const mcpServersToSync: Record<string, Record<string, unknown>> = {}
      const syncedMcpNames: string[] = []
      for (const [name, cfg] of Object.entries(mcpServers)) {
        if (cfg.active === false) continue
        const entry: Record<string, unknown> = {}
        if (cfg.command) entry.command = cfg.command
        if (cfg.args?.length) entry.args = cfg.args
        if (cfg.url) entry.url = cfg.url
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
        configPathOverride,
      })
      if (!settings.model && targetModel) {
        setModel(targetModel)
      }
      setMcpServerNames(syncedMcpNames)
      toast.success('Codex configured to use Jan via its user config.toml')
      loadFormFields()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to update Codex config', { description: message })
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeactivateJanProfile = async () => {
    setFormField('profile', '')
    toast.success('Jan profile deactivated — Codex will use default profile')
  }

  const handleReset = async () => {
    try {
      await invoke('clear_codex_config', {
        model: settings.model,
        mcpServerNames: settings.mcpServerNames,
        configPathOverride,
      })
      clearSettings()
      toast.success('Codex settings cleared')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Failed to clear Codex config', { description: message })
    }
  }

  return (
    <SettingsIntegrationPage>
      <div className="flex items-center justify-between">
        <h1 className="font-medium text-base">Codex</h1>
        <div className="flex items-center gap-3">
          {isSaving && <span className="text-xs text-muted-foreground">{t('codex.activating')}</span>}
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={handleReset}>
            {t('codex.reset')}
          </Button>
          <Switch
            checked={formFields.profile === 'jan'}
            onCheckedChange={(enabled) => {
              if (enabled) {
                void handleSave()
              } else {
                void handleDeactivateJanProfile()
              }
            }}
            disabled={isSaving}
          />
        </div>
      </div>

      <Card>
        <CardItem
          title="Model"
          description="Codex"
          actions={
            <IntegrationModelSelector
              providers={providers}
              selectedModel={settings.model}
              onSelect={(id) => {
                setModel(id ?? null)
                setFormField('model', id ?? '')
              }}
              placeholder={t('codex.notSet')}
              allowEmptyOption
              showSize
            />
          }
          descriptionOutside={
            <div className="flex flex-col gap-2">
              <JanCodeRecommendation selectedModel={settings.model} onSelect={(id) => { setModel(id); setFormField('model', id) }} />
            </div>
          }
        />
        <CardItem title={t('codex.behavior.reasoningEffortTitle')} description={t('codex.behavior.reasoningEffortDesc')} actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="min-w-[120px] justify-between">
                {formFields.model_reasoning_effort ? t(`codex.reasoningEffort.${formFields.model_reasoning_effort}`, { defaultValue: formFields.model_reasoning_effort }) : <span className="text-muted-foreground">{t('codex.notSet')}</span>}
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(['', 'low', 'medium', 'high'] as const).map((v) => (
                <DropdownMenuItem key={v} onClick={() => setFormField('model_reasoning_effort', v)}>
                  {v ? t(`codex.reasoningEffort.${v}`, { defaultValue: v }) : <span className="text-muted-foreground">{t('codex.notSet')}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        } />
        <CardItem title={t('codex.behavior.approvalPolicyTitle')} description={t('codex.behavior.approvalPolicyDesc')} actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="min-w-40 justify-between gap-2">
                {formFields.approval_policy === 'on-failure'
                  ? <IconTerminal2 size={14} className="text-muted-foreground shrink-0" />
                  : formFields.approval_policy === 'never'
                    ? <IconAlertCircle size={14} className="text-muted-foreground shrink-0" />
                    : <IconHandStop size={14} className="text-muted-foreground shrink-0" />}
                <span className="flex-1 text-left">
                  {formFields.approval_policy
                    ? t(`codex.approvalPolicy.${formFields.approval_policy}`, { defaultValue: formFields.approval_policy })
                    : t('codex.approvalPolicy.on-request')}
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {([
                { value: 'on-request', Icon: IconHandStop },
                { value: 'on-failure', Icon: IconTerminal2 },
                { value: 'never', Icon: IconAlertCircle },
              ] as const).map(({ value, Icon }) => (
                <DropdownMenuItem key={value} onClick={() => setFormField('approval_policy', value)}>
                  <Icon size={14} className="text-muted-foreground" />
                  {t(`codex.approvalPolicy.${value}`)}
                  {formFields.approval_policy === value && (
                    <span className="ml-auto text-xs text-muted-foreground">✓</span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        } />
        <CardItem title={t('codex.behavior.sandboxModeTitle')} description={t('codex.behavior.sandboxModeDesc')} actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="min-w-[180px] justify-between">
                {formFields.sandbox_mode ? t(`codex.sandboxMode.${formFields.sandbox_mode}`, { defaultValue: formFields.sandbox_mode }) : <span className="text-muted-foreground">{t('codex.notSet')}</span>}
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(['', 'off', 'workspace-write', 'danger-full-computer'] as const).map((v) => (
                <DropdownMenuItem key={v} onClick={() => setFormField('sandbox_mode', v)}>
                  {v ? t(`codex.sandboxMode.${v}`, { defaultValue: v }) : <span className="text-muted-foreground">{t('codex.notSet')}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        } />
      </Card>

      <Card>
        <CardItem title={t('codex.cliPaths.binaryTitle')} description={
          detectedBinary === undefined ? t('codex.cliPaths.detecting') : detectedBinary ? <span className="flex items-center gap-1.5"><IconCircleCheck size={13} className="text-green-500 shrink-0" />{t('codex.cliPaths.detectedAt')} <span className="font-mono text-xs">{detectedBinary}</span></span> : <span className="flex items-center gap-1.5"><IconCircleX size={13} className="text-destructive shrink-0" />{t('codex.cliPaths.notFound')}</span>
        } actions={
          <Button size="sm" variant="outline" onClick={runDetect} disabled={isDetecting} className="shrink-0">
            <IconRefresh size={13} className={isDetecting ? 'animate-spin' : ''} />
            {isDetecting ? t('codex.cliPaths.detecting') : t('codex.cliPaths.redetect')}
          </Button>
        } />
        <CardItem title={t('codex.cliPaths.customBinaryTitle')} description={t('codex.cliPaths.customBinaryDesc')} column actions={
          <Input value={settings.binaryPath} onChange={(e) => setBinaryPath(e.target.value)} placeholder="/usr/local/bin/codex" className="mt-1.5 h-8 text-sm font-mono" />
        } />
        <CardItem title={t('codex.cliPaths.customConfigTitle')} description={t('codex.cliPaths.customConfigDesc')} column actions={
          <Input value={settings.configFilePath} onChange={(e) => setConfigFilePath(e.target.value)} placeholder="~/.codex/config.toml" className="mt-1.5 h-8 text-sm font-mono" />
        } />
        <CardItem title={t('codex.globalDefaults.shellTitle')} description={t('codex.globalDefaults.shellDesc')} column actions={
          <Input value={formFields.shell} onChange={(e) => setFormField('shell', e.target.value)} placeholder="e.g. /bin/zsh" className="mt-1.5 h-8 text-sm" />
        } />
      </Card>

      <Card>
        <div className="space-y-1">
          <CardItem title={t('codex.limits.contextWindowTitle')} description={t('codex.limits.contextWindowDesc')} actions={
            <DynamicControllerSetting controllerType="input" controllerProps={{ type: 'number', value: formFields.model_context_window, placeholder: '200000', min: 1 }} onChange={(v) => setFormField('model_context_window', String(v))} />
          } />
          <CardItem title={t('codex.limits.autoCompactTitle')} description={t('codex.limits.autoCompactDesc')} actions={
            <DynamicControllerSetting controllerType="input" controllerProps={{ type: 'number', value: formFields.model_auto_compact_token_limit, placeholder: '160000', min: 1 }} onChange={(v) => setFormField('model_auto_compact_token_limit', String(v))} />
          } />
          <CardItem title={t('codex.limits.historyTokensTitle')} description={t('codex.limits.historyTokensDesc')} actions={
            <DynamicControllerSetting controllerType="input" controllerProps={{ type: 'number', value: formFields.history_max_context_tokens, placeholder: '10000', min: 1 }} onChange={(v) => setFormField('history_max_context_tokens', String(v))} />
          } />
          <CardItem title={t('codex.flags.disableStorageTitle')} description={t('codex.flags.disableStorageDesc')} actions={<Switch checked={formFields.disable_response_storage ?? false} onCheckedChange={(v) => setFormField('disable_response_storage', v)} />} />
          <CardItem title={t('codex.flags.notifyTitle')} description={t('codex.flags.notifyDesc')} actions={<Switch checked={formFields.notify_on_completion ?? false} onCheckedChange={(v) => setFormField('notify_on_completion', v)} />} />
          <CardItem title={t('codex.flags.hideReasoningTitle')} description={t('codex.flags.hideReasoningDesc')} actions={<Switch checked={formFields.hide_agent_reasoning ?? false} onCheckedChange={(v) => setFormField('hide_agent_reasoning', v)} />} />
          <CardItem title={t('codex.flags.fullStdoutTitle')} description={t('codex.flags.fullStdoutDesc')} actions={<Switch checked={formFields.full_stdout ?? false} onCheckedChange={(v) => setFormField('full_stdout', v)} />} />
        </div>
      </Card>
    </SettingsIntegrationPage>
  )
}

export function ClaudeCodeAgentSettings() {
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
  const { providers, selectedModel, selectedProvider, getProviderByName } = useModelProvider()
  const setActiveModels = useAppState((state) => state.setActiveModels)
  const {
    models: helperModels,
    setModel: setHelperModel,
    setEnvVars,
    setCustomCli,
    clearModels,
  } = useClaudeCodeModel()
  const [isCustomCliDialogOpen, setIsCustomCliDialogOpen] = useState(false)
  const [isModelLoading, setIsModelLoading] = useState(false)

  const handleLaunchClaudeCode = async () => {
    const apiUrl = `http://${serverHost}:${serverPort}`
    const modelBig = helperModels.big
    const modelMedium = helperModels.medium
    const modelSmall = helperModels.small
    const customEnvVars = helperModels.envVars

    const startServer = async (): Promise<void> => {
      const helperModelsToStart = [
        { id: helperModels.big, role: 'Big' },
        { id: helperModels.medium, role: 'Medium' },
        { id: helperModels.small, role: 'Small' },
      ].filter((m) => m.id).map((m) => m.id as string)

      const loadedModels = (await serviceHub.models().getActiveModels()) || []
      const modelsToStart = helperModelsToStart.filter((m) => !loadedModels.includes(m))

      if (modelsToStart.length > 0) {
        setIsModelLoading(true)
        for (const modelId of modelsToStart) {
          const providerWithModel = providers.find((p) => p.models.some((m) => m.id === modelId))
          if (providerWithModel) {
            await serviceHub.models().startModel(providerWithModel, modelId, true)
          }
        }
        setIsModelLoading(false)
        await serviceHub.models().getActiveModels().then((models) => setActiveModels(models || []))
        await new Promise((resolve) => setTimeout(resolve, 500))
      } else if (loadedModels.length === 0 && helperModelsToStart.length === 0) {
        const modelToStart = getModelToStart({ selectedModel, selectedProvider, getProviderByName })
        if (modelToStart) {
          setIsModelLoading(true)
          await serviceHub.models().startModel(modelToStart.provider, modelToStart.model, true)
          setIsModelLoading(false)
          await serviceHub.models().getActiveModels().then((models) => setActiveModels(models || []))
          await new Promise((resolve) => setTimeout(resolve, 500))
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
      } catch (startErr) {
        const msg = startErr instanceof Error ? startErr.message : String(startErr)
        if (!msg.includes('already running')) throw startErr
      }

      if (actualPort && actualPort !== serverPort) {
        setServerPort(actualPort)
      }
      setServerStatus('running')
      const activeModels = await serviceHub.models().getActiveModels().catch(() => [] as string[])
      if (activeModels.length > 0) {
        const serverModels = activeModels.flatMap((id) => {
          const p = providers.find((p) => p?.models?.some((m) => m.id === id))
          return p ? [{ model: id, provider: p.provider }] : []
        })
        if (serverModels.length > 0) setLastServerModels(serverModels)
      }
    }

    try {
      if (serverStatus === 'stopped') {
        toast.info('Starting server...', { description: 'Preparing server for Claude Code' })
        await startServer()
      }

      await invoke('launch_claude_code_with_config', {
        apiUrl,
        apiKey: apiKey || undefined,
        bigModel: modelBig || undefined,
        mediumModel: modelMedium || undefined,
        smallModel: modelSmall || undefined,
        customEnvVars: customEnvVars.map((env) => ({ key: env.key, value: env.value })),
      })
      toast.success('Environment variables updated. Please try relaunching Claude Code in a new terminal window.', { duration: 8000 })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      toast.error('Failed to configure env vars', { description: errorMsg })
    }
  }

  return (
    <SettingsIntegrationPage footer={<AddEditCustomCliDialog open={isCustomCliDialogOpen} onOpenChange={setIsCustomCliDialogOpen} initialEnvVars={helperModels.envVars} initialCustomCli={helperModels.customCli} onSave={(envVars, customCli) => { setEnvVars(envVars); setCustomCli(customCli) }} />}>
      <Card header={<div className="mb-3 flex w-full items-center gap-3"><svg width="20" height="20" viewBox="0 0 99 72" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0"><path d="M9 0H90V54H9V0Z" fill="#D77757" /><path d="M0 18H9V36H0V18Z" fill="#D77757" /><path d="M18 18H27V27H18V18Z" fill="black" /><path d="M72 18H81V27H72V18Z" fill="black" /><path d="M90 18H99V36H90V18Z" fill="#D77757" /><path d="M9 54H18V72H9V54Z" fill="#D77757" /><path d="M63 54H72V72H63V54Z" fill="#D77757" /><path d="M27 54H36V72H27V54Z" fill="#D77757" /><path d="M81 54H90V72H81V54Z" fill="#D77757" /></svg><h1 className="text-foreground font-studio font-medium text-base">Claude Code integration</h1></div>}>
        <CardItem title="Large Model" description="Opus" actions={<IntegrationModelSelector providers={providers} selectedModel={helperModels.big} onSelect={(model) => setHelperModel('big', model)} placeholder="Select Big Model" filterModel={(model) => model.isLocal || model.hasApiKey} />} />
        <CardItem title="Medium Model" description="Sonnet" actions={<IntegrationModelSelector providers={providers} selectedModel={helperModels.medium} onSelect={(model) => setHelperModel('medium', model)} placeholder="Select Medium Model" filterModel={(model) => model.isLocal || model.hasApiKey} />} />
        <CardItem title="Small Model" description="Haiku" actions={<IntegrationModelSelector providers={providers} selectedModel={helperModels.small} onSelect={(model) => setHelperModel('small', model)} placeholder="Select Small Model" filterModel={(model) => model.isLocal || model.hasApiKey} />} descriptionOutside={<JanCodeRecommendation selectedModel={helperModels.small} onSelect={(modelId: string) => setHelperModel('small', modelId)} />} />
        <div className="flex mt-2 justify-between gap-2 border-t pt-4">
          <Button size="sm" variant="outline" onClick={() => setIsCustomCliDialogOpen(true)}><IconPlus className="text-muted-foreground" size={14} />Environment Variables</Button>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={async () => { clearModels(); try { await invoke('clear_claude_code_env'); toast.success('Claude Code settings cleared') } catch (e) { toast.error(`Failed to clear env file: ${e}`) } }}>Reset</Button>
            <Button size="sm" onClick={handleLaunchClaudeCode} disabled={isModelLoading}>{isModelLoading ? 'Loading models...' : 'Save & Enable'}</Button>
          </div>
        </div>
        {(helperModels.customCli || helperModels.envVars.length > 0) && (<div className="mt-3 text-sm text-muted-foreground">{helperModels.customCli && <div>Command: {helperModels.customCli}</div>}{helperModels.envVars.length > 0 && <div className="break-all">Env: {helperModels.envVars.map((env) => `${env.key}=******`).join(', ')}</div>}</div>)}
      </Card>
    </SettingsIntegrationPage>
  )
}

export function HermesAgentSettings() {
  const { settings, setBinaryPath, setModel, setProvider, clearSettings } = useHermesSettings()

  return (
    <SettingsIntegrationPage>
      <div className="flex items-center justify-between">
        <h1 className="font-medium text-base">Hermes Agent</h1>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-muted-foreground"
          onClick={clearSettings}
        >
          Reset
        </Button>
      </div>

      <Card>
        <CardItem
          title="Binary Path"
          description="Custom path to the hermes CLI binary. Leave blank to use the system PATH."
          column
          actions={
            <Input
              value={settings.binaryPath}
              onChange={(e) => setBinaryPath(e.target.value)}
              placeholder="/usr/local/bin/hermes"
              className="mt-1.5 h-8 text-sm font-mono"
            />
          }
        />
        <CardItem
          title="Model Override"
          description="Pass a specific model to Hermes via --model (e.g. anthropic/claude-sonnet-4-5). Leave blank to use the Hermes default."
          column
          actions={
            <Input
              value={settings.model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. openai/gpt-4o"
              className="mt-1.5 h-8 text-sm font-mono"
            />
          }
        />
        <CardItem
          title="Provider Override"
          description="Pass a specific provider to Hermes via --provider (e.g. openrouter, openai). Leave blank to use the Hermes default."
          column
          actions={
            <Input
              value={settings.provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="e.g. openrouter"
              className="mt-1.5 h-8 text-sm font-mono"
            />
          }
        />
      </Card>
    </SettingsIntegrationPage>
  )
}
