import { cn } from '@/lib/utils'
import { IconBrain } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'

// ---- Codex reasoning effort dropdown ----------------------------------------

type CodexBehavior = {
  model_reasoning_effort: string
  approval_policy: string
  sandbox_mode: string
}

type CodexReasoningDropdownProps = {
  codexBehavior: CodexBehavior
  saveField: <K extends keyof CodexBehavior>(key: K, val: CodexBehavior[K]) => void
}

export function CodexReasoningDropdown({
  codexBehavior,
  saveField,
}: CodexReasoningDropdownProps) {
  const { t } = useTranslation('settings')
  const effortValue = codexBehavior.model_reasoning_effort
  const effortLabel = effortValue
    ? t(`codex.reasoningEffort.${effortValue}`, { defaultValue: effortValue })
    : '—'

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-1.5">
              <IconBrain
                size={18}
                className={cn('text-muted-foreground', effortValue && 'text-primary')}
              />
              <span className="text-xs text-muted-foreground lowercase">
                {effortLabel}
              </span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('codex.behavior.reasoningEffortTitle')}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {(['', 'low', 'medium', 'high'] as const).map((v) => (
          <DropdownMenuItem
            key={v === '' ? '__unset__' : v}
            onClick={() => saveField('model_reasoning_effort', v)}
          >
            {v ? (
              t(`codex.reasoningEffort.${v}`, { defaultValue: v })
            ) : (
              <span className="text-muted-foreground">{t('codex.notSet')}</span>
            )}
            {effortValue === v && (
              <span className="ml-auto text-xs text-muted-foreground">✓</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---- LlamaCpp reasoning auto/on/off dropdown ---------------------------------

type LlamacppReasoningDropdownProps = {
  selectedModel: Model | undefined | null
  selectedProvider: string | undefined
}

export function LlamacppReasoningDropdown({
  selectedModel,
  selectedProvider,
}: LlamacppReasoningDropdownProps) {
  const getProviderByName = useModelProvider((state) => state.getProviderByName)
  const updateProvider = useModelProvider((state) => state.updateProvider)
  const selectModelProvider = useModelProvider((state) => state.selectModelProvider)

  const reasoningValue =
    (selectedModel?.settings?.reasoning?.controller_props
      ?.value as 'auto' | 'on' | 'off' | undefined) ?? 'auto'

  const setReasoning = (value: 'auto' | 'on' | 'off') => {
    if (!selectedProvider || !selectedModel) return
    const providerObj = getProviderByName(selectedProvider)
    if (!providerObj) return
    const modelIndex = providerObj.models.findIndex((m) => m.id === selectedModel.id)
    if (modelIndex === -1) return
    const existing =
      selectedModel.settings?.reasoning ?? {
        key: 'reasoning',
        title: 'Reasoning',
        description: '',
        controller_type: 'dropdown',
        controller_props: { value },
      }
    const updatedModel = {
      ...selectedModel,
      settings: {
        ...selectedModel.settings,
        reasoning: {
          ...existing,
          controller_props: {
            ...(existing.controller_props ?? {}),
            value,
          },
        },
      },
    } as Model
    const updatedModels = [...providerObj.models]
    updatedModels[modelIndex] = updatedModel
    updateProvider(selectedProvider, { models: updatedModels })
    // Re-select to refresh the snapshot so the chat transport observes the new value.
    selectModelProvider(selectedProvider, selectedModel.id)
  }

  const label =
    reasoningValue === 'on' ? 'On' : reasoningValue === 'off' ? 'Off' : 'Auto'
  const tooltipText =
    reasoningValue === 'on'
      ? 'Reasoning forced on for every request.'
      : reasoningValue === 'off'
        ? 'Reasoning disabled for every request.'
        : "Reasoning auto-detected from the model's chat template."

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Reasoning: ${label}`}
            >
              <IconBrain
                size={18}
                className={cn(
                  'text-muted-foreground',
                  reasoningValue === 'on' && 'text-primary',
                  reasoningValue === 'off' && 'opacity-50'
                )}
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start">
        {(['auto', 'on', 'off'] as const).map((v) => (
          <DropdownMenuItem key={v} onClick={() => setReasoning(v)}>
            {v === 'auto' ? 'Auto' : v === 'on' ? 'On' : 'Off'}
            {reasoningValue === v && (
              <span className="ml-auto text-xs text-muted-foreground">✓</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
