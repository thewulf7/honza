import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// ---------------------------------------------------------------------------
// Types mirroring Claude Code's streaming-JSON event schema.
// We keep a flexible base type so the UI can handle any future event without
// a TypeScript error, while still narrowing via `item.type` in the renderer.
// ---------------------------------------------------------------------------

export type ClaudeItemStatus = 'in_progress' | 'completed' | 'failed'

export interface ClaudeItem extends Record<string, unknown> {
  id: string
  type: string
  status?: ClaudeItemStatus
}

export type TurnPhase =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'

export interface ClaudeSession {
  /**
   * The Claude Code session ID returned by the `system` init event.
   * Empty string before the first turn completes.
   */
  claudeSessionId: string
  /** Ordered list of item IDs for rendering. */
  orderedItemIds: string[]
  /** Current item states keyed by id. */
  items: Record<string, ClaudeItem>
  phase: TurnPhase
  error: string | null
  /** Token / cost usage from the last `result` event. */
  usage: {
    input_tokens?: number
    output_tokens?: number
    cost_usd?: number
  } | null
}

// ---------------------------------------------------------------------------
// Tauri event payload shape (must match `ClaudeAgentEvent` in Rust)
// ---------------------------------------------------------------------------

interface ClaudeAgentEventPayload {
  event: Record<string, unknown>
  session_id: string
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const CLAUDE_SESSION_KEY_PREFIX = 'claude-agent-session-id'

function loadClaudeSessionId(agentKey: string): string {
  try {
    return (
      localStorage.getItem(`${CLAUDE_SESSION_KEY_PREFIX}:${agentKey}`) ?? ''
    )
  } catch {
    return ''
  }
}

function saveClaudeSessionId(agentKey: string, claudeSessionId: string) {
  try {
    if (claudeSessionId) {
      localStorage.setItem(
        `${CLAUDE_SESSION_KEY_PREFIX}:${agentKey}`,
        claudeSessionId
      )
    } else {
      localStorage.removeItem(`${CLAUDE_SESSION_KEY_PREFIX}:${agentKey}`)
    }
  } catch {
    // ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Event → session reducer
// ---------------------------------------------------------------------------

let _nextId = 0
function nextId() {
  return `claude-item-${++_nextId}`
}

function applyEvent(
  session: ClaudeSession,
  raw: Record<string, unknown>
): ClaudeSession {
  const type = raw['type'] as string | undefined

  switch (type) {
    // ── system init ────────────────────────────────────────────────
    case 'system': {
      return session // session_id already captured in the hook
    }

    // ── assistant message ──────────────────────────────────────────
    case 'assistant': {
      const msg = raw['message'] as Record<string, unknown> | undefined
      const content = (msg?.['content'] as unknown[]) ?? []

      // Each content block becomes its own renderable item.
      const newItems: Record<string, ClaudeItem> = { ...session.items }
      const newIds = [...session.orderedItemIds]

      for (const block of content) {
        const b = block as Record<string, unknown>
        const id = nextId()
        if (b['type'] === 'text') {
          newItems[id] = {
            id,
            type: 'assistant_text',
            text: b['text'] as string,
            status: 'completed',
          }
          newIds.push(id)
        } else if (b['type'] === 'tool_use') {
          newItems[id] = {
            id,
            type: 'tool_use',
            tool_name: b['name'] as string,
            tool_input: b['input'],
            status: 'in_progress',
          }
          newIds.push(id)
        }
      }

      return { ...session, items: newItems, orderedItemIds: newIds }
    }

    // ── user / tool result ─────────────────────────────────────────
    case 'user': {
      const content = (raw['message'] as Record<string, unknown>)?.[
        'content'
      ] as unknown[] | undefined
      if (!content) return session

      const newItems = { ...session.items }
      const newIds = [...session.orderedItemIds]

      for (const block of content) {
        const b = block as Record<string, unknown>
        if (b['type'] === 'tool_result') {
          // Find the matching tool_use item and mark it completed.
          const toolUseId = b['tool_use_id'] as string | undefined
          if (toolUseId) {
            for (const itemId of newIds) {
              const item = newItems[itemId]
              if (
                item &&
                item.type === 'tool_use' &&
                item.tool_use_id === toolUseId
              ) {
                newItems[itemId] = {
                  ...item,
                  status: 'completed',
                  result: b['content'],
                }
              }
            }
          }
        }
      }

      return { ...session, items: newItems, orderedItemIds: newIds }
    }

    // ── final result ───────────────────────────────────────────────
    case 'result': {
      const subtype = raw['subtype'] as string | undefined
      const isError = raw['is_error'] as boolean | undefined

      if (subtype === 'cancelled') {
        return { ...session, phase: 'completed' }
      }

      const usage =
        raw['total_input_tokens'] != null || raw['total_output_tokens'] != null
          ? {
              input_tokens: raw['total_input_tokens'] as number | undefined,
              output_tokens: raw['total_output_tokens'] as number | undefined,
              cost_usd: raw['total_cost_usd'] as number | undefined,
            }
          : null

      if (isError) {
        return {
          ...session,
          phase: 'failed',
          error: (raw['result'] as string | undefined) ?? 'Claude returned an error.',
          usage,
        }
      }

      return { ...session, phase: 'completed', usage }
    }

    // ── error (parse failures forwarded by Rust) ───────────────────
    case 'error': {
      const id = nextId()
      const newItems = {
        ...session.items,
        [id]: {
          id,
          type: 'error',
          message: raw['message'] as string,
          status: 'failed' as ClaudeItemStatus,
        },
      }
      return {
        ...session,
        items: newItems,
        orderedItemIds: [...session.orderedItemIds, id],
      }
    }

    default:
      return session
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const INITIAL_SESSION: ClaudeSession = {
  claudeSessionId: '',
  orderedItemIds: [],
  items: {},
  phase: 'idle',
  error: null,
  usage: null,
}

/**
 * Manages a Claude Code agent session: spawns `claude --output-format
 * stream-json`, streams events via Tauri's `claude://agent-event` channel,
 * and exposes session state to the UI.
 *
 * @param agentKey  Stable key used to persist the Claude session ID in
 *                  localStorage (defaults to `"default"`).
 */
export function useClaudeCodeAgent(agentKey = 'default', options?: { binaryPath?: string }) {
  const [session, setSession] = useState<ClaudeSession>(() => ({
    ...INITIAL_SESSION,
    claudeSessionId: loadClaudeSessionId(agentKey),
  }))

  // Stable opaque ID that identifies this component instance's Tauri events.
  const sessionIdRef = useRef(crypto.randomUUID())
  // Tracks the latest Claude session ID without causing run() to re-create.
  const claudeSessionIdRef = useRef(session.claudeSessionId)

  // Cleanup fn for the Tauri event listener.
  const unlistenRef = useRef<(() => void) | null>(null)

  // Set up the Tauri event listener once on mount.
  useEffect(() => {
    let active = true

    listen<ClaudeAgentEventPayload>('claude://agent-event', (tauriEvent) => {
      const { event, session_id } = tauriEvent.payload

      // Ignore events intended for other hook instances.
      if (session_id !== sessionIdRef.current) return

      // Capture the session_id from the system init event immediately so
      // we can persist and resume it.
      if (event['type'] === 'system') {
        const sid = event['session_id'] as string | undefined
        if (sid) {
          claudeSessionIdRef.current = sid
          saveClaudeSessionId(agentKey, sid)
          setSession((prev) => ({ ...prev, claudeSessionId: sid }))
        }
      }

      setSession((prev) => applyEvent(prev, event))
    })
      .then((unlisten) => {
        if (!active) {
          unlisten()
        } else {
          unlistenRef.current = unlisten
        }
      })
      .catch((err) => {
        console.error('[useClaudeCodeAgent] Failed to set up event listener:', err)
      })

    return () => {
      active = false
      unlistenRef.current?.()
      unlistenRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Start a new agent turn.  If the session has a non-empty `claudeSessionId`,
   * Claude Code will resume that conversation.
   */
  const run = useCallback(
    async (prompt: string, workingDir?: string) => {
      const currentSessionId = sessionIdRef.current

      setSession((prev) => ({
        ...prev,
        phase: 'running',
        error: null,
        // Keep existing items so the user can see prior turns above the new one.
      }))

      try {
        const newClaudeSessionId = await invoke<string>('claude_run_turn', {
          sessionId: currentSessionId,
          prompt,
          claudeSessionId: claudeSessionIdRef.current || null,
          workingDir: workingDir ?? null,
          binaryPath: options?.binaryPath || null,
        })

        // Only persist/overwrite when Rust returned a real session ID.
        // On early cancellation the ID may be empty — preserve the existing one.
        if (newClaudeSessionId) {
          claudeSessionIdRef.current = newClaudeSessionId
          saveClaudeSessionId(agentKey, newClaudeSessionId)
          setSession((prev) => ({
            ...prev,
            claudeSessionId: newClaudeSessionId,
            phase: 'completed',
          }))
        } else {
          setSession((prev) => ({ ...prev, phase: 'completed' }))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setSession((prev) => ({
          ...prev,
          phase: 'failed',
          error: message,
        }))
      }
    },
    [agentKey]
  )

  /** Request cancellation of the in-progress turn. */
  const stop = useCallback(async () => {
    setSession((prev) => ({ ...prev, phase: 'cancelling' }))
    try {
      await invoke('claude_stop_turn')
    } catch (err) {
      console.error('[useClaudeCodeAgent] stop failed:', err)
    }
  }, [])

  /** Clear all accumulated items and start a brand-new conversation. */
  const newSession = useCallback(() => {
    sessionIdRef.current = crypto.randomUUID()
    saveClaudeSessionId(agentKey, '')
    setSession({ ...INITIAL_SESSION, claudeSessionId: '' })
  }, [agentKey])

  return { session, run, stop, newSession }
}
