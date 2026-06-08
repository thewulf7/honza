import { ChevronsUpDown } from 'lucide-react'
import {
  IconHandStop,
  IconTerminal2,
  IconAlertCircle,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTranslation } from '@/i18n/react-i18next-compat'

const CODEX_APPROVAL_POLICIES = [
  { value: 'on-request' as const, Icon: IconHandStop },
  { value: 'on-failure' as const, Icon: IconTerminal2 },
  { value: 'never' as const, Icon: IconAlertCircle },
]

type CodexBehavior = {
  approval_policy: string
  sandbox_mode: string
  model_reasoning_effort: string
}

type Props = {
  codexBehavior: CodexBehavior
  saveField: <K extends keyof CodexBehavior>(key: K, val: CodexBehavior[K]) => void
}

export function CodexBehaviorToolbar({ codexBehavior, saveField }: Props) {
  const { t } = useTranslation('settings')

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
            {codexBehavior.approval_policy === 'on-failure' ? (
              <IconTerminal2 size={14} className="text-muted-foreground" />
            ) : codexBehavior.approval_policy === 'never' ? (
              <IconAlertCircle size={14} className="text-muted-foreground" />
            ) : (
              <IconHandStop size={14} className="text-muted-foreground" />
            )}
            <span>
              {codexBehavior.approval_policy
                ? t(`codex.approvalPolicy.${codexBehavior.approval_policy}`, {
                    defaultValue: codexBehavior.approval_policy,
                  })
                : t('codex.approvalPolicy.on-request')}
            </span>
            <ChevronsUpDown className="size-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {CODEX_APPROVAL_POLICIES.map(({ value, Icon }) => (
            <DropdownMenuItem
              key={value}
              onClick={() => saveField('approval_policy', value)}
            >
              <Icon size={14} className="text-muted-foreground" />
              {t(`codex.approvalPolicy.${value}`)}
              {codexBehavior.approval_policy === value && (
                <span className="ml-auto text-xs text-muted-foreground">✓</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
            <span className="text-muted-foreground">
              {t('codex.behavior.sandboxModeTitle')}:
            </span>
            <span>
              {codexBehavior.sandbox_mode
                ? t(`codex.sandboxMode.${codexBehavior.sandbox_mode}`, {
                    defaultValue: codexBehavior.sandbox_mode,
                  })
                : t('codex.notSet')}
            </span>
            <ChevronsUpDown className="size-3 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {(['', 'off', 'workspace-write', 'danger-full-computer'] as const).map((v) => (
            <DropdownMenuItem
              key={v === '' ? '__unset__' : v}
              onClick={() => saveField('sandbox_mode', v)}
            >
              {v ? (
                t(`codex.sandboxMode.${v}`, { defaultValue: v })
              ) : (
                <span className="text-muted-foreground">{t('codex.notSet')}</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
