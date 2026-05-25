/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
} from 'react'
import {
  IconRobot,
  IconPlayerStopFilled,
  IconSend,
  IconRotateClockwise,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconArrowLeft,
  IconCheck,
  IconX,
  IconBrain,
  IconSearch,
  IconTool,
  IconFile,
  IconTerminal2,
  IconAlertTriangle,
} from '@tabler/icons-react'

import { route } from '@/constants/routes'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { cn } from '@/lib/utils'
import { useCodexAgent, type CodexItem } from '@/hooks/useCodexAgent'

// ---------------------------------------------------------------------------

export const Route = createFileRoute(route.codexAgent as any)({
  component: CodexAgentPage,
})

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function CodexAgentPage() {
  const navigate = useNavigate()
  const { session, run, stop, newSession } = useCodexAgent()

  const [prompt, setPrompt] = useState('')
  const [workingDir, setWorkingDir] = useState('~')

  // Scroll-to-bottom when new items arrive
  const bottomRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session.orderedItemIds.length])

  const isRunning =
    session.phase === 'running' || session.phase === 'cancelling'

  const handleSend = useCallback(async () => {
    const trimmed = prompt.trim()
    if (!trimmed || isRunning) return
    setPrompt('')
    await run(trimmed, workingDir)
  }, [prompt, isRunning, run, workingDir])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => navigate({ to: route.settings.codex })}
          title="Back to Codex settings"
        >
          <IconArrowLeft size={16} />
        </Button>

        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex h-6 w-6 items-center justify-center rounded-sm border border-border/60 bg-secondary/40 shrink-0">
            <IconRobot size={14} className="text-foreground" />
          </div>
          <h1 className="text-base font-medium text-foreground truncate">
            Codex Agent
          </h1>
          {session.threadId && (
            <span
              className="text-xs text-muted-foreground truncate max-w-[180px]"
              title={`Thread: ${session.threadId}`}
            >
              #{session.threadId.slice(0, 12)}…
            </span>
          )}
        </div>

        {/* Working directory */}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
          <IconFolder size={13} className="shrink-0" />
          <input
            type="text"
            value={workingDir}
            onChange={(e) => setWorkingDir(e.target.value)}
            className="bg-transparent border border-border/50 rounded px-2 py-0.5 text-xs text-foreground w-40 focus:outline-none focus:border-border"
            placeholder="Working directory"
          />
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-7 gap-1.5 text-muted-foreground hover:text-foreground shrink-0"
          onClick={newSession}
          disabled={isRunning}
          title="Clear session and start fresh"
        >
          <IconRotateClockwise size={13} />
          New session
        </Button>
      </div>

      {/* ── Messages ────────────────────────────────────────────────── */}
      <div
        ref={messagesRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      >
        {session.orderedItemIds.length === 0 && session.phase === 'idle' && (
          <EmptyState hasThread={!!session.threadId} />
        )}

        {session.orderedItemIds.map((id) => {
          const item = session.items[id]
          if (!item) return null
          return <CodexItemView key={id} item={item} />
        })}

        {/* Running indicator */}
        {isRunning && session.orderedItemIds.length === 0 && (
          <ThinkingIndicator />
        )}

        {/* Error banner */}
        {session.phase === 'failed' && session.error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-sm">
            <IconAlertTriangle size={16} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-medium mb-0.5">Turn failed</p>
              <p className="text-xs opacity-80">{session.error}</p>
            </div>
          </div>
        )}

        {/* Usage summary */}
        {session.phase === 'completed' && session.usage && (
          <div className="text-xs text-muted-foreground text-right">
            {session.usage.input_tokens != null && (
              <span>in: {session.usage.input_tokens} </span>
            )}
            {session.usage.output_tokens != null && (
              <span>out: {session.usage.output_tokens} tokens</span>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input ───────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <div className="flex gap-2 items-end">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              session.threadId
                ? 'Continue the conversation… (⌘↵ to send)'
                : 'What should Codex do? (⌘↵ to send)'
            }
            className="flex-1 min-h-[72px] max-h-[200px] resize-none text-sm"
            disabled={isRunning}
          />
          <div className="flex flex-col gap-2">
            {isRunning ? (
              <Button
                variant="destructive"
                size="icon"
                onClick={stop}
                className="h-9 w-9"
                title="Stop"
              >
                <IconPlayerStopFilled size={15} />
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={handleSend}
                disabled={!prompt.trim()}
                className="h-9 w-9"
                title="Send (⌘↵)"
              >
                <IconSend size={15} />
              </Button>
            )}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5">
          Codex must be installed and your Jan integration saved in{' '}
          <button
            className="underline hover:text-foreground transition-colors"
            onClick={() => navigate({ to: route.settings.codex })}
          >
            Settings → Codex
          </button>
          .
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ hasThread }: { hasThread: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-48 text-center text-muted-foreground gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border/60 bg-secondary/30">
        <IconRobot size={24} className="opacity-60" />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground/70">
          {hasThread ? 'Session paused' : 'Codex Agent ready'}
        </p>
        <p className="text-xs mt-1 opacity-70">
          {hasThread
            ? 'Continue the conversation below.'
            : 'Type a task and press ⌘↵ to run Codex.'}
        </p>
      </div>
    </div>
  )
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="flex gap-1">
        <span className="animate-bounce [animation-delay:0ms]">·</span>
        <span className="animate-bounce [animation-delay:150ms]">·</span>
        <span className="animate-bounce [animation-delay:300ms]">·</span>
      </span>
      Running…
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item dispatcher
// ---------------------------------------------------------------------------

function CodexItemView({ item }: { item: CodexItem }) {
  switch (item.type) {
    case 'agent_message':
      return <AgentMessage item={item} />
    case 'reasoning':
      return <ReasoningBlock item={item} />
    case 'command_execution':
      return <CommandExecutionBlock item={item} />
    case 'file_change':
      return <FileChangeBlock item={item} />
    case 'mcp_tool_call':
      return <McpToolCallBlock item={item} />
    case 'todo_list':
      return <TodoListBlock item={item} />
    case 'web_search':
      return <WebSearchBlock item={item} />
    case 'error':
      return <ItemErrorBlock item={item} />
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Agent message — Markdown from the model
// ---------------------------------------------------------------------------

function AgentMessage({ item }: { item: CodexItem }) {
  const text = (item.text as string) ?? ''
  const isStreaming = item.status === 'in_progress'
  if (!text) return null
  return (
    <div className="flex gap-3">
      <div className="flex h-6 w-6 items-center justify-center rounded-sm border border-border/60 bg-secondary/40 shrink-0 mt-0.5">
        <IconRobot size={13} className="text-foreground" />
      </div>
      <div className="flex-1 min-w-0 prose prose-sm dark:prose-invert max-w-none">
        <RenderMarkdown
          content={text}
          isStreaming={isStreaming}
          messageId={item.id}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reasoning block — collapsible chain-of-thought
// ---------------------------------------------------------------------------

function ReasoningBlock({ item }: { item: CodexItem }) {
  const [open, setOpen] = useState(false)
  const text = (item.text as string) ?? ''
  const isStreaming = item.status === 'in_progress'

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-secondary/30 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <IconBrain size={13} className="shrink-0" />
        <span className="flex-1 text-left font-medium">
          {isStreaming ? 'Thinking…' : 'Reasoning'}
        </span>
        {open ? (
          <IconChevronDown size={13} />
        ) : (
          <IconChevronRight size={13} />
        )}
      </button>
      {open && text && (
        <div className="px-3 pb-3 pt-1 text-xs text-muted-foreground italic">
          <RenderMarkdown content={text} isStreaming={isStreaming} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Command execution block
// ---------------------------------------------------------------------------

function CommandExecutionBlock({ item }: { item: CodexItem }) {
  const [open, setOpen] = useState(true)
  const command = (item.command as string) ?? ''
  const output = (item.aggregated_output as string) ?? ''
  const exitCode = item.exit_code as number | undefined
  const status = item.status as string | undefined

  const succeeded =
    status === 'completed' && (exitCode === 0 || exitCode == null)
  const failed = status === 'completed' && exitCode != null && exitCode !== 0

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden font-mono text-xs">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 bg-secondary/20 hover:bg-secondary/40 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <IconTerminal2 size={13} className="text-muted-foreground shrink-0" />
        <span className="flex-1 text-left text-foreground truncate">
          $ {command}
        </span>
        {status === 'in_progress' && (
          <span className="text-muted-foreground animate-pulse">running…</span>
        )}
        {succeeded && (
          <span className="flex items-center gap-1 text-green-500">
            <IconCheck size={12} /> ok
          </span>
        )}
        {failed && (
          <span className="flex items-center gap-1 text-red-500">
            <IconX size={12} /> exit {exitCode}
          </span>
        )}
        {open ? (
          <IconChevronDown size={13} className="text-muted-foreground" />
        ) : (
          <IconChevronRight size={13} className="text-muted-foreground" />
        )}
      </button>
      {open && output && (
        <pre className="p-3 text-[11px] leading-relaxed text-muted-foreground overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto bg-background/50">
          {output}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// File change block
// ---------------------------------------------------------------------------

type FileChange = { path: string; kind: string }

function FileChangeBlock({ item }: { item: CodexItem }) {
  const changes = (item.changes as FileChange[]) ?? []
  if (changes.length === 0) return null

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden text-xs">
      <div className="flex items-center gap-2 px-3 py-2 bg-secondary/20">
        <IconFile size={13} className="text-muted-foreground shrink-0" />
        <span className="text-muted-foreground font-medium">
          {changes.length} file{changes.length !== 1 ? 's' : ''} changed
        </span>
        {item.status === 'in_progress' && (
          <span className="text-muted-foreground animate-pulse">…</span>
        )}
      </div>
      <div className="divide-y divide-border/30">
        {changes.map((c, i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-1.5 font-mono"
          >
            <span
              className={cn(
                'font-bold shrink-0 w-3',
                c.kind === 'added' || c.kind === 'create'
                  ? 'text-green-500'
                  : c.kind === 'deleted' || c.kind === 'delete'
                    ? 'text-red-500'
                    : 'text-yellow-500'
              )}
            >
              {c.kind === 'added' || c.kind === 'create'
                ? '+'
                : c.kind === 'deleted' || c.kind === 'delete'
                  ? '−'
                  : '~'}
            </span>
            <span className="text-foreground truncate">{c.path}</span>
            <span className="ml-auto text-muted-foreground capitalize shrink-0">
              {c.kind}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MCP tool call block
// ---------------------------------------------------------------------------

function McpToolCallBlock({ item }: { item: CodexItem }) {
  const [open, setOpen] = useState(false)
  const server = (item.server as string) ?? ''
  const tool = (item.tool as string) ?? ''
  const args = item.arguments as Record<string, unknown> | undefined
  const result = item.result as string | undefined
  const error = item.error as string | undefined
  const status = item.status as string | undefined

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden text-xs">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 bg-secondary/20 hover:bg-secondary/40 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <IconTool size={13} className="text-muted-foreground shrink-0" />
        <span className="flex-1 text-left truncate">
          <span className="text-muted-foreground">{server} /</span>{' '}
          <span className="text-foreground font-medium">{tool}</span>
        </span>
        {status === 'in_progress' && (
          <span className="text-muted-foreground animate-pulse">running…</span>
        )}
        {status === 'completed' && !error && (
          <IconCheck size={12} className="text-green-500" />
        )}
        {(status === 'failed' || error) && (
          <IconX size={12} className="text-red-500" />
        )}
        {open ? (
          <IconChevronDown size={13} className="text-muted-foreground" />
        ) : (
          <IconChevronRight size={13} className="text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="p-3 space-y-2 bg-background/50">
          {args && (
            <div>
              <p className="text-muted-foreground mb-1">Arguments</p>
              <pre className="text-[11px] text-foreground overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result && (
            <div>
              <p className="text-muted-foreground mb-1">Result</p>
              <pre className="text-[11px] text-foreground overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                {result}
              </pre>
            </div>
          )}
          {error && (
            <div className="text-red-400">
              <p className="font-medium mb-1">Error</p>
              <p className="text-[11px]">{error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Todo list block
// ---------------------------------------------------------------------------

type TodoItem = { text: string; completed: boolean }

function TodoListBlock({ item }: { item: CodexItem }) {
  const items = (item.items as TodoItem[]) ?? []
  if (items.length === 0) return null

  const done = items.filter((i) => i.completed).length

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden text-xs">
      <div className="flex items-center gap-2 px-3 py-2 bg-secondary/20">
        <IconCheck size={13} className="text-muted-foreground" />
        <span className="text-muted-foreground font-medium">
          Tasks ({done}/{items.length})
        </span>
      </div>
      <ul className="divide-y divide-border/30">
        {items.map((t, i) => (
          <li key={i} className="flex items-start gap-2 px-3 py-1.5">
            <span
              className={cn(
                'mt-0.5 shrink-0',
                t.completed ? 'text-green-500' : 'text-muted-foreground'
              )}
            >
              {t.completed ? (
                <IconCheck size={12} />
              ) : (
                <span className="inline-block w-3 h-3 rounded-sm border border-border/60" />
              )}
            </span>
            <span
              className={cn(
                t.completed
                  ? 'line-through text-muted-foreground'
                  : 'text-foreground'
              )}
            >
              {t.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Web search block
// ---------------------------------------------------------------------------

function WebSearchBlock({ item }: { item: CodexItem }) {
  const query = (item.query as string) ?? ''
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border/50 text-xs bg-secondary/10">
      <IconSearch size={13} className="text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">Searching for</span>
      <span className="text-foreground font-medium truncate">{query}</span>
      {item.status === 'in_progress' && (
        <span className="ml-auto text-muted-foreground animate-pulse shrink-0">
          …
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Item-level error block
// ---------------------------------------------------------------------------

function ItemErrorBlock({ item }: { item: CodexItem }) {
  const message = (item.message as string) ?? 'Unknown error'
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-xs text-destructive">
      <IconAlertTriangle size={13} className="shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  )
}
