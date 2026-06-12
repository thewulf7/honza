/**
 * Minimal SSE helpers for consuming mistralrs-server's OpenAI-compatible
 * streaming responses.
 */

export const OUT_OF_CONTEXT_SIZE = 'the request exceeds the available context size.'

/**
 * Appends a decoded network chunk to the carry-over buffer and splits out
 * complete lines. Returns `[lines, remainder]`, where `remainder` is the
 * trailing partial line to feed into the next call. Blank lines (SSE event
 * separators) are dropped.
 */
export function appendToBuffer(
  buffer: string,
  chunk: string
): [string[], string] {
  const combined = buffer + chunk
  const segments = combined.split('\n')
  const remainder = segments.pop() ?? ''
  const lines = segments
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0)
  return [lines, remainder]
}

/**
 * Parses a single SSE line.
 *
 * - `data: {...}` → the parsed JSON payload
 * - `data: [DONE]`, comments, or other fields → null
 *
 * Throws `SyntaxError` on malformed JSON, an `OUT_OF_CONTEXT_SIZE` error
 * when the server reports a `length` finish reason, and a generic error
 * when the payload carries an `error` field.
 */
export function parseSseLine(line: string): unknown | null {
  if (!line.startsWith('data:')) return null

  const payload = line.slice('data:'.length).trim()
  if (!payload || payload === '[DONE]') return null

  const parsed = JSON.parse(payload)

  if (parsed?.error) {
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error.message ?? JSON.stringify(parsed.error))
    throw new Error(message)
  }

  if (parsed?.choices?.[0]?.finish_reason === 'length') {
    throw new Error(OUT_OF_CONTEXT_SIZE)
  }

  return parsed
}
