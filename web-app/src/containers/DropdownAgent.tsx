import { memo, useCallback, useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { useNavigate } from '@tanstack/react-router'
import { ChevronsUpDown } from 'lucide-react'
import { IconSettings } from '@tabler/icons-react'

import { route } from '@/constants/routes'
import { getLastUsedAgent, setLastUsedAgent } from '@/constants/localStorage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { BUILT_IN_AGENTS, renderAgentTypeIcon } from '@/containers/agents/agentDefinitions'

type DropdownAgentProps = {
  selectedAgentId: string
  onSelectAgent: (agentId: string) => void
}

type SelectableAgent = {
  id: string
  name: string
  description: string
  agentType: AgentType
}

const SELECTABLE_AGENTS: SelectableAgent[] = BUILT_IN_AGENTS.map((agent) => ({
  id: agent.id,
  name: agent.name,
  description: agent.description,
  agentType: agent.id,
}))

const DropdownAgent = memo(function DropdownAgent({
  selectedAgentId,
  onSelectAgent,
}: DropdownAgentProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const selectableAgents = SELECTABLE_AGENTS

  useEffect(() => {
    const existingSelection = selectableAgents.some(
      (agent) => agent.id === selectedAgentId
    )
    if (existingSelection) return

    const lastUsedAgent = getLastUsedAgent()
    const fallbackAgentId =
      (lastUsedAgent &&
        selectableAgents.find((agent) => agent.id === lastUsedAgent)?.id) ||
      selectableAgents[0]?.id

    if (fallbackAgentId) {
      onSelectAgent(fallbackAgentId)
    }
  }, [onSelectAgent, selectableAgents, selectedAgentId])

  const selectedAgent =
    selectableAgents.find((agent) => agent.id === selectedAgentId) ??
    selectableAgents[0]

  const handleSelect = useCallback(
    (agentId: string) => {
      onSelectAgent(agentId)
      setLastUsedAgent(agentId)
      setOpen(false)
    },
    [onSelectAgent]
  )

  if (!selectedAgent) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="border relative z-20 px-4 py-1.5 flex items-center gap-1.5 rounded-full min-w-0">
          <button
            type="button"
            className="font-medium cursor-pointer flex items-center gap-1.5 relative z-20 min-w-0"
          >
            <div className="shrink-0">
              {renderAgentTypeIcon(selectedAgent.agentType, 16, 'text-foreground opacity-70')}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-foreground truncate leading-normal">
                  {selectedAgent.name}
                </span>
              </TooltipTrigger>
              <TooltipContent>{selectedAgent.name}</TooltipContent>
            </Tooltip>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </div>
      </PopoverTrigger>

      <PopoverContent
        className="w-80 p-0 backdrop-blur-2xl bg-background/95 border"
        align="start"
        side="bottom"
      >
        <div className="flex flex-col size-full py-1">
          <div className="px-3 py-2 border-b text-sm font-medium">
            {t('common:agents')}
          </div>

          <div className="max-h-80 overflow-y-auto py-1">
            <AgentSection
              title={t('common:agents')}
              agents={selectableAgents}
              selectedAgentId={selectedAgent.id}
              onSelect={handleSelect}
              onOpenSettings={(agentId) =>
                navigate({
                  to: route.settings.agentDetail,
                  params: { agentName: agentId },
                })
              }
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
})

function AgentSection({
  title,
  agents,
  selectedAgentId,
  onSelect,
  onOpenSettings,
}: {
  title: string
  agents: SelectableAgent[]
  selectedAgentId: string
  onSelect: (agentId: string) => void
  onOpenSettings: (agentId: string) => void
}) {
  return (
    <div className="bg-secondary/30 rounded-sm my-1.5 mx-1.5 first:mt-1 py-1">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <span className="text-sm font-medium text-muted-foreground">
          {title}
        </span>
      </div>

      {agents.map((agent) => {
        const isSelected = selectedAgentId === agent.id

        return (
          <div
            key={agent.id}
            onClick={() => onSelect(agent.id)}
            className={cn(
              'mx-1 mb-1 px-2 py-1.5 rounded-sm cursor-pointer flex items-center gap-2 transition-all duration-200',
              'hover:bg-secondary/40',
              isSelected && 'bg-primary/15 hover:bg-primary/15 ring-1 ring-primary/40'
            )}
          >
            <div className="shrink-0">
              {renderAgentTypeIcon(agent.agentType, 16, 'text-foreground opacity-70')}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm truncate">{agent.name}</span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {agent.description}
              </p>
            </div>

            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              onClick={(event) => {
                event.stopPropagation()
                onOpenSettings(agent.id)
              }}
            >
              <IconSettings size={14} className="text-muted-foreground" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}

export default DropdownAgent