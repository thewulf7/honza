import type { ReactElement } from 'react'
import { cn } from '@/lib/utils'
import {
  CodexAgentSettings,
  ClaudeCodeAgentSettings,
} from '@/containers/agents/builtInAgentSettings'

export type AgentDefinition = BuiltInAgent & {
  renderSettings: () => ReactElement
}

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI Codex CLI — agentic coding with configurable profiles',
    renderSettings: () => <CodexAgentSettings />,
  },
  {
    id: 'claude',
    name: 'Claude Code',
    description: 'Anthropic Claude Code — agentic coding with model tier setup',
    renderSettings: () => <ClaudeCodeAgentSettings />,
  },
]

export const BUILT_IN_AGENTS: BuiltInAgent[] = AGENT_DEFINITIONS.map(
  ({ renderSettings, ...agent }) => agent
)

export const getBuiltInAgent = (agentType: AgentType) =>
  BUILT_IN_AGENTS.find((agent) => agent.id === agentType)

export function renderAgentTypeIcon(
  agentType: AgentType,
  size = 16,
  className?: string
) {
  if (agentType === 'codex') {
    return (
      <img
        src="/images/codex-color.svg"
        width={size}
        height={size}
        className={cn('dark:invert', className)}
      />
    )
  }

  return (
    <img
      src="/images/code-claude.svg"
      width={size}
      height={size}
      className={cn('dark:invert', className)}
    />
  )
}
