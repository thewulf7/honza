# Jan Web App

React + TypeScript frontend for the Jan desktop application. Built with Vite, TanStack Router, Radix UI, and Tailwind CSS.

## Getting Started

```bash
# From the repo root (recommended)
make dev

# Or directly
cd web-app
yarn install
yarn dev
```

## Project Structure

```text
web-app/src/
├── components/
│   ├── ui/                  # Radix-based primitives (Button, Dialog, Popover…)
│   └── left-sidebar/        # Sidebar with Chat/Agents toggle
├── containers/
│   ├── agents/              # Agent system: definitions, settings UI, AgentSettingsPage
│   ├── ChatInput.tsx         # Message composer with agent/model selection
│   ├── DropdownAgent.tsx     # Agent picker popover
│   └── SettingsMenu.tsx      # Settings sidebar navigation
├── hooks/
│   ├── useClaudeCodeAgent.ts # Claude Code CLI session hook
│   ├── useCodexAgent.ts      # OpenAI Codex CLI session hook
│   ├── useCodexSettings.ts   # Codex settings persistence
│   ├── useSidebarMode.ts     # Chat/Agents sidebar toggle (Zustand)
│   └── ...
├── routes/
│   ├── agent.tsx             # /agent — unified agent chat page
│   ├── settings/agents/      # /settings/agents and /settings/agents/$agentName
│   └── ...
├── constants/
│   ├── localStorage.ts       # Shared localStorage keys and helpers
│   └── routes.ts             # Typed route constants
├── locales/                  # i18n JSON files (en/)
└── types/
    └── agentProfiles.d.ts    # Global AgentType, AgentProfile, BuiltInAgent types
```

## Agent System

The agents feature lets users run external CLI agents (Codex, Claude Code) from within Jan.

- **`containers/agents/agentDefinitions.tsx`** — `BUILT_IN_AGENTS` registry, icon renderer
- **`containers/agents/builtInAgentSettings.tsx`** — Settings UI for each agent type
- **`containers/agents/AgentSettingsPage.tsx`** — Route-level wrapper; reads `agentName` param
- **`hooks/useCodexAgent.ts`** — Spawns `codex` CLI, streams JSONL via Tauri events
- **`hooks/useClaudeCodeAgent.ts`** — Spawns `claude` CLI, streams JSONL via Tauri events

To add a new built-in agent, add an entry to `AGENT_DEFINITIONS` in `agentDefinitions.tsx` and implement its `renderSettings` component.

## Key Conventions

- **Routing**: file-based via TanStack Router; `routeTree.gen.ts` is auto-generated — do not edit manually
- **State**: local `useState` for component state, Zustand `persist` for global/cross-session state
- **Tauri IPC**: `invoke()` from `@tauri-apps/api/core`; events via `listen()` from `@tauri-apps/api/event`
- **i18n**: `useTranslation()` from the local compat wrapper; keys live in `locales/en/`
- **No `any`**: TypeScript is required throughout

## Testing

```bash
yarn test          # Vitest unit tests
yarn type-check    # TypeScript check without emitting
yarn lint          # ESLint
```
