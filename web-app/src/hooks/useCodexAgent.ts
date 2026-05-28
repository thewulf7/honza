import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// ---------------------------------------------------------------------------
// Types mirroring the Codex SDK's ThreadItem and ThreadEvent unions.
// We keep them as `Record<string, unknown>` at the base level so we can
// render any future item type without a TypeScript error, while still
// narrowing in the UI via `item.type`.
// ---------------------------------------------------------------------------

export type CodexItemStatus = 'in_progress' | 'completed' | 'failed'

export interface CodexItem extends Record<string, unknown> {
  id: string
  type: string
  status?: CodexItemStatus
}

export type TurnPhase =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'

export interface CodexSession {
  /** The Codex thread ID — empty string on first turn, populated after that. */
  threadId: string
  /** Ordered list of item IDs for rendering. */
  orderedItemIds: string[]
  /** Current item states keyed by id. */
  items: Record<string, CodexItem>
  phase: TurnPhase
  error: string | null
  /** Token usage from the last `turn.completed` event. */
  usage: { input_tokens?: number; output_tokens?: number } | null
}

// ---------------------------------------------------------------------------
// Tauri event payload shape (must match `CodexAgentEvent` in Rust)
// ---------------------------------------------------------------------------

interface CodexAgentEventPayload {
  event: Record<string, unknown>
  session_id: string
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const THREAD_KEY_PREFIX = 'codex-agent-thread-id'

function loadThreadId(agentKey: string): string {
  try {
    return localStorage.getItem(`${THREAD_KEY_PREFIX}:${agentKey}`) ?? ''
  } catch {
    return ''
  }
}

function saveThreadId(agentKey: string, threadId: string) {
  try {
    if (threadId) {
      localStorage.setItem(`${THREAD_KEY_PREFIX}:${agentKey}`, threadId)
    } else {
      localStorage.removeItem(`${THREAD_KEY_PREFIX}:${agentKey}`)
    }
  } catch {
    // ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const INITIAL_SESSION: CodexSession = {
  threadId: '',
  orderedItemIds: [],
  items: {},
  phase: 'idle',
  error: null,
  usage: null,
}

/**
 * Manages a Codex agent session: spawns `codex exec`, streams events via
 * Tauri's `codex://agent-event` channel, and exposes session state to the UI.
 *
 * @param agentKey  Stable key used to persist the thread ID in localStorage
 *                  (defaults to `"default"`).  Pass different keys to support
 *                  multiple independent sessions in the same app.
 */
export function useCodexAgent(agentKey = 'default', options?: { binaryPath?: string; configFilePath?: string }) {
  const [session, setSession] = useState<CodexSession>(() => ({
    ...INITIAL_SESSION,
    threadId: loadThreadId(agentKey),
  }))

  // Stable opaque ID that identifies this component instance's Tauri events.
  const sessionIdRef = useRef(crypto.randomUUID())

  // Cleanup fn for the Tauri event listener.
  const unlistenRef = useRef<(() => void) | null>(null)

  // Set up the Tauri event listener once on mount.
  useEffect(() => {
    let active = true

    listen<CodexAgentEventPayload>('codex://agent-event', (tauriEvent) => {
      const { event, session_id } = tauriEvent.payload

      // Ignore events intended for other hook instances.
      if (session_id !== sessionIdRef.current) return

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
        console.error('[useCodexAgent] Failed to set up event listener:', err)
      })

    return () => {
      active = false
      unlistenRef.current?.()
      unlistenRef.current = null
    }
  }, []) // intentionally empty — we only subscribe once

  /**
   * Start a new agent turn.  If the session has a non-empty `threadId`,
   * Codex will resume that thread (multi-turn conversation).
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
        const newThreadId = await invoke<string>('codex_run_turn', {
          sessionId: currentSessionId,
          prompt,
          threadId: session.threadId || null,
          workingDir: workingDir ?? null,
          binaryPath: options?.binaryPath || null,
          configPath: options?.configFilePath || null,
        })

        // Persist thread ID for future page loads.
        saveThreadId(agentKey, newThreadId)

        setSession((prev) => ({
          ...prev,
          threadId: newThreadId,
          phase: 'completed',
        }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setSession((prev) => ({
          ...prev,
          phase: 'failed',
          error: message,
        }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agentKey, session.threadId]
  )

  /** Request cancellation of the in-progress turn. */
  const stop = useCallback(async () => {
    setSession((prev) => ({ ...prev, phase: 'cancelling' }))
    try {
      await invoke('codex_stop_turn')
    } catch (err) {
      console.error('[useCodexAgent] stop failed:', err)
    }
  }, [])

  /** Clear all accumulated items and start fresh (new thread). */
  const newSession = useCallback(() => {
    sessionIdRef.current = crypto.randomUUID()
    saveThreadId(agentKey, '')
    setSession({ ...INITIAL_SESSION, threadId: '' })
  }, [agentKey])

  return { session, run, stop, newSession }
}

// ---------------------------------------------------------------------------
// Pure state reducer for incoming Codex events
// ---------------------------------------------------------------------------

function applyEvent(
  prev: CodexSession,
  event: Record<string, unknown>
): CodexSession {
  const type = event['type'] as string | undefined

  switch (type) {
    case 'thread.started': {
      const threadId = (event['thread_id'] as string) ?? prev.threadId
      saveThreadId('default', threadId) // best-effort; hook also persists
      return { ...prev, threadId }
    }

    case 'turn.started':
      return { ...prev, phase: 'running', error: null }

    case 'turn.completed': {
      const usage =
        (event['usage'] as { input_tokens?: number; output_tokens?: number }) ??
        null
      return { ...prev, phase: 'completed', usage }
    }

    case 'turn.failed': {
      const errMsg =
        ((event['error'] as Record<string, unknown>)?.['message'] as string) ??
        'Unknown error'
      return { ...prev, phase: 'failed', error: errMsg }
    }

    case 'turn.cancelled':
      return { ...prev, phase: 'idle' }

    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event['item'] as CodexItem | undefined
      if (!item?.id) return prev

      const alreadyPresent = !!prev.items[item.id]
      const nextItems = { ...prev.items, [item.id]: item }
      const nextOrderedIds = alreadyPresent
        ? prev.orderedItemIds
        : [...prev.orderedItemIds, item.id]

      return { ...prev, items: nextItems, orderedItemIds: nextOrderedIds }
    }

    case 'error': {
      const message = (event['message'] as string) ?? 'Unknown agent error'
      return { ...prev, phase: 'failed', error: message }
    }

    default:
      return prev
  }
}
