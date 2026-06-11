export const OUT_OF_CONTEXT_SIZE = 'the request exceeds the available context size.'

export interface SseChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{
    index?: number
    delta?: { role?: string; content?: string }
    finish_reason?: string | null
  }>
  [key: string]: unknown
}

/**
 * Combine buffer + new incoming text, split on `\n`, and return complete
 * lines (ready to parse) plus the new remainder.
 *
 * SSE events end with `\n\n`, so splitting on `\n` produces an empty
 * element between events that the parser skips.
 */
export function appendToBuffer(
  buffer: string,
  incoming: string
): [string[], string] {
  const combined = buffer + incoming
  const lines = combined.split('\n')
  const remainder = lines.pop() ?? ''
  return [lines, remainder]
}

/**
 * Parse one SSE line (may contain trailing `\r` from CRLF streams).
 *
 * Returns a parsed chunk for `data: {...}` lines.
 * Returns null for empty lines and `data: [DONE]`.
 * Throws `Error(OUT_OF_CONTEXT_SIZE)` when `finish_reason === "length"`.
 * Throws with the server-provided message for `error: {...}` lines.
 * Lets `SyntaxError` from `JSON.parse` propagate so the caller can
 * distinguish a malformed payload from an expected application error.
 */
export function parseSseLine(line: string): SseChunk | null {
  const trimmed = line.trim()

  if (!trimmed || trimmed === 'data: [DONE]') return null

  if (trimmed.startsWith('data: ')) {
    const data = JSON.parse(trimmed.slice(6)) as SseChunk
    if (data.choices?.[0]?.finish_reason === 'length') {
      throw new Error(OUT_OF_CONTEXT_SIZE)
    }
    return data
  }

  if (trimmed.startsWith('error: ')) {
    const errObj = JSON.parse(trimmed.slice(7)) as { message: string }
    throw new Error(errObj.message)
  }

  return null
}
