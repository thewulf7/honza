import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import SettingsMenu from '@/containers/SettingsMenu'
import HeaderPage from '@/containers/HeaderPage'
import { Button } from '@/components/ui/button'
import { Card, CardItem } from '@/containers/Card'
import { renderAgentTypeIcon } from '@/containers/agents/agentDefinitions'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { BUILT_IN_AGENTS } from '@/containers/agents/agentDefinitions'
import { IconSettings } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/settings/agents/')({
  component: AgentsList,
})

function AgentsList() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div
          className={cn(
            'flex items-center justify-between w-full mr-2 pr-3',
            !IS_MACOS && 'pr-30'
          )}
        >
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
        </div>
      </HeaderPage>

      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full h-[calc(100%-32px)] overflow-y-auto">
          <div className="flex flex-col gap-4 gap-y-3 w-full">
            <Card
              header={
                <div className="flex items-center justify-between w-full mb-6">
                  <span className="font-medium text-base font-studio text-foreground">
                    {t('common:agents')}
                  </span>
                </div>
              }
            >
              {BUILT_IN_AGENTS.map((agent) => (
                <CardItem
                  key={agent.id}
                  title={
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-sm border border-border/60 bg-secondary/40 shrink-0">
                        {renderAgentTypeIcon(agent.id, 16, 'text-foreground opacity-70')}
                      </div>
                      <div>
                        <h3 className="font-medium">{agent.name}</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {agent.description}
                        </p>
                      </div>
                    </div>
                  }
                  actions={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() =>
                        navigate({
                          to: route.settings.agentDetail,
                          params: { agentName: agent.id },
                        })
                      }
                    >
                      <IconSettings className="text-muted-foreground" size={16} />
                    </Button>
                  }
                />
              ))}
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
