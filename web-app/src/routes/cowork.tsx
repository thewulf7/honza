/* eslint-disable @typescript-eslint/no-explicit-any */
import { useRef, useState } from 'react'
import { createFileRoute, useSearch, useNavigate } from '@tanstack/react-router'
import HeaderPage from '@/containers/HeaderPage'
import SetupScreen from '@/containers/SetupScreen'
import DropdownAgent from '@/containers/DropdownAgent'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { predefinedProviders } from '@/constants/providers'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useCoworkTasks } from '@/hooks/useCoworkTasks'
import { useAgentMode } from '@/hooks/useAgentMode'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { getLastUsedAgent } from '@/constants/localStorage'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { cn } from '@/lib/utils'
import { Workflow, SendIcon } from 'lucide-react'

type SearchParams = {
  taskId?: string
}

export const Route = createFileRoute(route.cowork as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    taskId: search.taskId as string | undefined,
  }),
})

function Index() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { providers } = useModelProvider()
  const search = useSearch({ from: route.cowork as any })
  const { tasks, addTask, updateTask } = useCoworkTasks()
  const [selectedAgentId] = useState(getLastUsedAgent)
  const [input, setInput] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const activeTask = search.taskId
    ? tasks.find((t) => t.id === search.taskId)
    : null

  const hasValidProviders = providers.some((provider) => {
    const isPredefinedProvider = predefinedProviders.some(
      (p) => p.provider === provider.provider
    )
    if (!isPredefinedProvider) return provider.models.length > 0
    return (
      providerHasRemoteApiKeys(provider) ||
      (provider.provider === 'llamacpp' && provider.models.length) ||
      (provider.provider === 'mistralrs' && provider.models.length) ||
      (provider.provider === 'jan' && provider.models.length)
    )
  })

  if (!hasValidProviders) {
    return <SetupScreen />
  }

  const handleSubmit = () => {
    const title = input.trim()
    if (!title || isSubmitting) return
    setIsSubmitting(true)
    const task = addTask(title)
    updateTask(task.id, { status: 'running' })
    useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
    navigate({ to: route.agent })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // Task detail view
  if (activeTask) {
    return (
      <div className="flex h-full flex-col justify-center">
        <HeaderPage>
          <div className="flex items-center gap-2 w-full">
            <DropdownAgent
              selectedAgentId={selectedAgentId}
              onSelectAgent={() => {}}
            />
            <DropdownModelProvider />
          </div>
        </HeaderPage>
        <div className="h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3">
          <div className="mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20">
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center mb-3">
                <div className="flex h-8 w-8 items-center justify-center shrink-0 text-foreground opacity-80">
                  <Workflow size={26} />
                </div>
              </div>
              <h1 className="text-xl font-studio font-medium">{activeTask.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground capitalize">{activeTask.status}</p>
            </div>
            <div className="flex justify-center gap-2">
              <button
                type="button"
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                onClick={() => {
                  useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
                  navigate({ to: route.agent })
                }}
              >
                {t('common:newSession')}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // New task creation view
  return (
    <div className="flex h-full flex-col justify-center">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <DropdownAgent
            selectedAgentId={selectedAgentId}
            onSelectAgent={() => {}}
          />
          <DropdownModelProvider />
        </div>
      </HeaderPage>
      <div className="h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3">
        <div className="mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20">
          <div className="text-center mb-4">
            <div className="inline-flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center shrink-0 text-foreground opacity-80">
                <Workflow size={26} />
              </div>
              <h1 className={cn('text-2xl mt-2 font-studio font-medium')}>
                {t('common:cowork')}
              </h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Describe a task and let your agent take care of it
            </p>
          </div>
          <div className="relative rounded-xl border bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring">
            <textarea
              ref={textareaRef}
              className="w-full resize-none rounded-xl bg-transparent px-4 pt-4 pb-12 text-sm placeholder:text-muted-foreground focus:outline-none"
              placeholder="Describe your task..."
              rows={4}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              <button
                type="button"
                disabled={!input.trim() || isSubmitting}
                onClick={handleSubmit}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  input.trim() && !isSubmitting
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                )}
              >
                <SendIcon size={13} />
                Run task
              </button>
            </div>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Press <kbd className="rounded bg-muted px-1 py-0.5 text-[10px]">Enter</kbd> to run
            &nbsp;&middot;&nbsp;
            <kbd className="rounded bg-muted px-1 py-0.5 text-[10px]">Shift+Enter</kbd> for newline
          </p>
        </div>
      </div>
    </div>
  )
}
