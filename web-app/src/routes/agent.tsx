/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react'
import { createFileRoute, useSearch } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import DropdownAgent from '@/containers/DropdownAgent'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import HeaderPage from '@/containers/HeaderPage'
import SetupScreen from '@/containers/SetupScreen'
import { getBuiltInAgent, renderAgentTypeIcon } from '@/containers/agents/agentDefinitions'
import { getLastUsedAgent } from '@/constants/localStorage'
import { predefinedProviders } from '@/constants/providers'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useTools } from '@/hooks/useTools'
import { providerHasRemoteApiKeys } from '@/lib/provider-api-keys'
import { cn } from '@/lib/utils'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
}


export const Route = createFileRoute(route.agent as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      threadModel: search.threadModel as ThreadModel | undefined,
    }

    return result
  },
})

function Index() {
  const { t } = useTranslation()
  const { providers } = useModelProvider()
  const search = useSearch({ from: route.agent as any })
  const threadModel = search.threadModel
  const [selectedAgentId, setSelectedAgentId] = useState(getLastUsedAgent)
  const { setCurrentThreadId } = useThreads()
  useTools()

  const selectedAgentType: AgentType = selectedAgentId === 'claude' ? 'claude' : 'codex'
  const selectedBuiltInAgent = getBuiltInAgent(selectedAgentType)
  const selectedAgentTitle = selectedBuiltInAgent?.name ?? t('common:agents')

  // Conditional to check if there are any valid providers
  // required min 1 api_key or 1 model in llama.cpp or jan provider
  // Custom providers (not in predefinedProviders) don't require api_key but need models
  const hasValidProviders = providers.some((provider) => {
    const isPredefinedProvider = predefinedProviders.some(
      (p) => p.provider === provider.provider
    )

    // Custom providers don't need API key validation but must have models
    if (!isPredefinedProvider) {
      return provider.models.length > 0
    }

    // Predefined providers need either API key or models (for llamacpp/jan)
    return (
      providerHasRemoteApiKeys(provider) ||
      (provider.provider === 'llamacpp' && provider.models.length) ||
      (provider.provider === 'jan' && provider.models.length)
    )
  })

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  if (!hasValidProviders) {
    return <SetupScreen />
  }

  return (
    <div className="flex h-full flex-col justify-center">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <DropdownAgent
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
          />
          <DropdownModelProvider model={threadModel} />
        </div>
      </HeaderPage>
      <div
        className={cn(
          'h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3'
        )}
      >
        <div
          className={cn(
            'mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20',
          )}
        >
          <div className={cn('text-center mb-4')}>
            <div className="inline-flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center shrink-0">
                {renderAgentTypeIcon(
                  selectedAgentType,
                  26,
                  'text-foreground opacity-80'
                )}
              </div>
              <h1
                className={cn(
                  'text-2xl mt-2 font-studio font-medium',
                )}
              >
                {selectedAgentTitle}
              </h1>
            </div>
          </div>
          <ChatInput
            showSpeedToken={false}
            model={threadModel}
            initialMessage={true}
            agentId={selectedAgentId}
          />
        </div>
      </div>
    </div>
  )
}
