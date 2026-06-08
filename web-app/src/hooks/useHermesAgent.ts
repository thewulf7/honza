import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HermesItemStatus = 'in_progress' | 'completed' | 'failed'

export interface HermesItem extends Record<string, unknown> {
  id: string
  type: string
  status?: HermesItemStatus
}

export type TurnPhase = 'idle' | 'running' | 'cancelling' | 'completed' | 'failed'

export interface HermesSession {
  /**
   * Opaque session marker.  Empty string = no prior session (next turn starts
   * fresh).  `"continue"` = there is a prior Hermes session; the next turn
   * will pass `--continue` to resume it.
   */
  hermesSession: string
  /** Ordered list of item IDs for rendering. */
  orderedItemIds: string[]
  /** Current item states keyed by id. */
  items: Record<string, HermesItem>
  phase: TurnPhase
  error: string | null
}

// ---------------------------------------------------------------------------
// Tauri event payload (must match `HermesAgentEvent` in Rust)
// ---------------------------------------------------------------------------

interface HermesAgentEventPayload {
  event: Record<string, unknown>
  session_id: string
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const SESSION_KEY_PREFIX = 'hermes-agent-session'

function loadHermesSession(agentKey: string): string {
  try {
    return localStorage.getItem(`${SESSION_KEY_PREFIX}:${agentKey}`) ?? ''
  } catch {
    return ''
  }
}

function saveHermesSession(agentKey: string, value: string) {
  try {
    if (value) {
      localStorage.setItem(`${SESSION_KEY_PREFIX}:${agentKey}`, value)
    } else {
      localStorage.removeItem(`${SESSION_KEY_PREFIX}:${agentKey}`)
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Event → session reducer
// ---------------------------------------------------------------------------

let _nextId = 0
function nextId() {
  return `hermes-item-${++_nextId}`
}

function applyEvent(
  session: HermesSession,
  raw: Record<string, unknown>
): HermesSession {
  const type = raw['type'] as string | undefined

  switch (type) {
    case 'text_chunk': {
      const text = raw['text'] as string | undefined
      if (!text) return session

      // Append to the last assistant_text item if it exists; otherwise create one.
      const lastId = session.orderedItemIds[session.orderedItemIds.length - 1]
      const lastItem = lastId ? session.items[lastId] : undefined

      if (lastItem?.type === 'assistant_text') {
        return {
          ...session,
          items: {
            ...session.items,
            [lastId]: {
              ...lastItem,
              text: `${lastItem.text as string}\n${text}`,
            },
          },
        }
      }

      const id = nextId()
      return {
        ...session,
        items: {
          ...session.items,
          [id]: { id, type: 'assistant_text', text, status: 'in_progress' },
        },
        orderedItemIds: [...session.orderedItemIds, id],
      }
    }

    case 'result': {
      const subtype = raw['subtype'] as string | undefined

      // Mark last text item as completed.
      const lastId = session.orderedItemIds[session.orderedItemIds.length - 1]
      const updatedItems =
        lastId && session.items[lastId]?.type === 'assistant_text'
          ? {
              ...session.items,
              [lastId]: { ...session.items[lastId], status: 'completed' as HermesItemStatus },
            }
          : session.items

      if (subtype === 'cancelled') {
        return { ...session, items: updatedItems, phase: 'completed' }
      }
      return { ...session, items: updatedItems, phase: 'completed' }
    }

    case 'error': {
      const id = nextId()
      return {
        ...session,
        items: {
          ...session.items,
          [id]: {
            id,
            type: 'error',
            message: raw['message'] as string,
            status: 'failed',
          },
        },
        orderedItemIds: [...session.orderedItemIds, id],
        phase: 'failed',
        error: (raw['message'] as string) ?? 'Hermes returned an error.',
      }
    }

    default:
      return session
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const INITIAL_SESSION: HermesSession = {
  hermesSession: '',
  orderedItemIds: [],
  items: {},
  phase: 'idle',
  error: null,
}

/**
 * Manages a Hermes agent session: spawns `hermes chat --quiet --yolo -q
 * <prompt>`, streams events via Tauri's `hermes://agent-event` channel, and
 * exposes session state to the UI.
 *
 * @param agentKey  Stable key used to persist the Hermes session marker in
 *                  localStorage (defaults to `"default"`).
 */
export function useHermesAgent(
  agentKey = 'default',
  options?: { binaryPath?: string; model?: string; provider?: string }
) {
  const [session, setSession] = useState<HermesSession>(() => ({
    ...INITIAL_SESSION,
    hermesSession: loadHermesSession(agentKey),
  }))

  const sessionIdRef = useRef(crypto.randomUUID())
  const hermesSessionRef = useRef(session.hermesSession)
  const unlistenRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    let active = true

    listen<HermesAgentEventPayload>('hermes://agent-event', (tauriEvent) => {
      const { event, session_id } = tauriEvent.payload
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
        console.error('[useHermesAgent] Failed to set up event listener:', err)
      })

    return () => {
      active = false
      unlistenRef.current?.()
      unlistenRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Start a new agent turn. */
  const run = useCallback(
    async (prompt: string, workingDir?: string) => {
      const currentSessionId = sessionIdRef.current

      setSession((prev) => ({
        ...prev,
        phase: 'running',
        error: null,
      }))

      try {
        const newHermesSession = await invoke<string>('hermes_run_turn', {
          sessionId: currentSessionId,
          prompt,
          hermesSession: hermesSessionRef.current || null,
          workingDir: workingDir ?? null,
          binaryPath: options?.binaryPath || null,
          model: options?.model || null,
          provider: options?.provider || null,
        })

        if (newHermesSession) {
          hermesSessionRef.current = newHermesSession
          saveHermesSession(agentKey, newHermesSession)
          setSession((prev) => ({
            ...prev,
            hermesSession: newHermesSession,
            phase: 'completed',
          }))
        } else {
          setSession((prev) => ({ ...prev, phase: 'completed' }))
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setSession((prev) => ({ ...prev, phase: 'failed', error: message }))
      }
    },
    [agentKey, options?.binaryPath, options?.model, options?.provider]
  )

  /** Request cancellation of the in-progress turn. */
  const stop = useCallback(async () => {
    setSession((prev) => ({ ...prev, phase: 'cancelling' }))
    try {
      await invoke('hermes_stop_turn')
    } catch (err) {
      console.error('[useHermesAgent] stop failed:', err)
    }
  }, [])

  /** Clear all accumulated items and start a brand-new conversation. */
  const newSession = useCallback(() => {
    sessionIdRef.current = crypto.randomUUID()
    hermesSessionRef.current = ''
    saveHermesSession(agentKey, '')
    setSession({ ...INITIAL_SESSION, hermesSession: '' })
  }, [agentKey])

  return { session, run, stop, newSession }
}
