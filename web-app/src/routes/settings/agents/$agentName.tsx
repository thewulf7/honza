import { createFileRoute } from '@tanstack/react-router'
import { AgentSettingsPage } from '@/containers/agents/AgentSettingsPage'

export const Route = createFileRoute('/settings/agents/$agentName')({
  component: AgentSettingsPage,
})
