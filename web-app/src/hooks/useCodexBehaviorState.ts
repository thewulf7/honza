import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'

type CodexBehavior = {
  model_reasoning_effort: string
  approval_policy: string
  sandbox_mode: string
}

type UseCodexBehaviorStateOptions = {
  localSelectedAgentType: AgentType
  configFilePath?: string
}

export function useCodexBehaviorState({
  localSelectedAgentType,
  configFilePath,
}: UseCodexBehaviorStateOptions) {
  const [codexBehavior, setCodexBehavior] = useState<CodexBehavior>({
    model_reasoning_effort: '',
    approval_policy: '',
    sandbox_mode: '',
  })
  const saveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (saveRef.current) clearTimeout(saveRef.current) }, [])

  useEffect(() => {
    if (localSelectedAgentType !== 'codex') return
    const configPathOverride = configFilePath || null
    invoke<Record<string, unknown>>('parse_codex_config_fields', { configPathOverride })
      .then((fields) => {
        setCodexBehavior({
          model_reasoning_effort: (fields.model_reasoning_effort as string | null) ?? '',
          approval_policy: (fields.approval_policy as string | null) ?? '',
          sandbox_mode: (fields.sandbox_mode as string | null) ?? '',
        })
      })
      .catch(() => {})
  }, [localSelectedAgentType, configFilePath])

  const saveCodexBehaviorField = <K extends keyof CodexBehavior>(
    key: K,
    val: CodexBehavior[K]
  ) => {
    const next = { ...codexBehavior, [key]: val }
    setCodexBehavior(next)
    if (saveRef.current) clearTimeout(saveRef.current)
    saveRef.current = setTimeout(() => {
      const configPathOverride = configFilePath || null
      invoke('update_codex_config_fields', {
        fields: {
          model_reasoning_effort: next.model_reasoning_effort || null,
          approval_policy: next.approval_policy || null,
          sandbox_mode: next.sandbox_mode || null,
        },
        configPathOverride,
      }).catch((err: unknown) => {
        console.error('Failed to save Codex config field:', err)
      })
    }, 300)
  }

  return { codexBehavior, saveCodexBehaviorField }
}
