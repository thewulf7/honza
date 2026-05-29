import { useNavigate, useParams } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import {
  AGENT_DEFINITIONS,
} from '@/containers/agents/agentDefinitions'
import { Button } from '@/components/ui/button'
import SettingsIntegrationPage from '@/containers/SettingsIntegrationPage'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function AgentSettingsPage() {
  const { agentName } = useParams({ from: '/settings/agents/$agentName' })
  const definition = AGENT_DEFINITIONS.find((item) => item.id === agentName)

  if (definition) {
    return definition.renderSettings()
  }

  return <UnknownAgent />
}

function UnknownAgent() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <SettingsIntegrationPage>
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
        <p>{t('common:agentProfileNotFound')}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate({ to: route.settings.agents })}
        >
          {t('common:backToAgents')}
        </Button>
      </div>
    </SettingsIntegrationPage>
  )
}
