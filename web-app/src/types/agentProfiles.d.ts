export {}

declare global {
  type AgentType = 'codex' | 'claude'

  interface AgentProfile {
    id: string
    name: string
    agentType: AgentType
    enabled: boolean
    createdAt: number
  }

  interface BuiltInAgent {
    id: AgentType
    name: string
    description: string
  }
}