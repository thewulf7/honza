import { describe, it, expect } from 'vitest'
import { OUT_OF_CONTEXT_SIZE, SseChunk, appendToBuffer, parseSseLine } from './sse'

// ─── appendToBuffer ────────────────────────────────────────────────────────

describe('appendToBuffer', () => {
  it('returns complete lines and empty remainder for a chunk ending with \\n', () => {
    const [lines, rem] = appendToBuffer('', 'line1\nline2\n')
    expect(lines).toEqual(['line1', 'line2'])
    expect(rem).toBe('')
  })

  it('keeps trailing partial line as remainder', () => {
    const [lines, rem] = appendToBuffer('', 'line1\npartial')
    expect(lines).toEqual(['line1'])
    expect(rem).toBe('partial')
  })

  it('prepends leftover buffer from the previous read', () => {
    const [lines, rem] = appendToBuffer('par', 'tial\nnext\n')
    expect(lines).toEqual(['partial', 'next'])
    expect(rem).toBe('')
  })

  it('handles an event boundary split across two network chunks', () => {
    const [lines1, rem1] = appendToBuffer('', 'data: {"id":"1","ch')
    expect(lines1).toEqual([])
    expect(rem1).toBe('data: {"id":"1","ch')

    const [lines2, rem2] = appendToBuffer(rem1, 'oices":[]}\n\n')
    expect(lines2).toEqual(['data: {"id":"1","choices":[]}', ''])
    expect(rem2).toBe('')
  })

  it('produces empty elements for \\n\\n SSE event separators', () => {
    const [lines, rem] = appendToBuffer('', 'data: {}\n\ndata: {}\n\n')
    expect(lines).toEqual(['data: {}', '', 'data: {}', ''])
    expect(rem).toBe('')
  })

  it('returns no lines and unchanged remainder for empty incoming string (keepalive)', () => {
    const [lines, rem] = appendToBuffer('existing', '')
    expect(lines).toEqual([])
    expect(rem).toBe('existing')
  })

  it('handles CRLF line endings (\\r remains on each line, trim handles it)', () => {
    const [lines] = appendToBuffer('', 'data: {}\r\n\r\n')
    expect(lines[0]).toBe('data: {}\r')
    expect(lines[1]).toBe('\r')
  })
})

// ─── parseSseLine ──────────────────────────────────────────────────────────

describe('parseSseLine', () => {
  it('returns null for empty string (SSE event separator)', () => {
    expect(parseSseLine('')).toBeNull()
    expect(parseSseLine('   ')).toBeNull()
    expect(parseSseLine('\r')).toBeNull()
  })

  it('returns null for data: [DONE]', () => {
    expect(parseSseLine('data: [DONE]')).toBeNull()
    expect(parseSseLine('data: [DONE]\r')).toBeNull()
  })

  it('parses a normal data line and returns the chunk', () => {
    const chunk = parseSseLine(
      'data: {"id":"abc","choices":[{"delta":{"content":"hi"},"index":0,"finish_reason":null}]}'
    )
    expect(chunk).not.toBeNull()
    expect(chunk!.id).toBe('abc')
    expect(chunk!.choices?.[0]?.delta?.content).toBe('hi')
    expect(chunk!.choices?.[0]?.finish_reason).toBeNull()
  })

  it('returns null for unknown SSE fields (comment, event, retry)', () => {
    expect(parseSseLine(': keepalive')).toBeNull()
    expect(parseSseLine('event: start')).toBeNull()
    expect(parseSseLine('retry: 3000')).toBeNull()
  })

  it('throws OUT_OF_CONTEXT_SIZE when finish_reason is "length"', () => {
    expect(() =>
      parseSseLine(
        'data: {"id":"x","choices":[{"delta":{},"index":0,"finish_reason":"length"}]}'
      )
    ).toThrow(OUT_OF_CONTEXT_SIZE)
  })

  it('does NOT throw for finish_reason "stop"', () => {
    expect(() =>
      parseSseLine(
        'data: {"id":"x","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}'
      )
    ).not.toThrow()
    const chunk = parseSseLine(
      'data: {"id":"x","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}'
    )
    expect(chunk!.choices?.[0]?.finish_reason).toBe('stop')
  })

  it('throws with the server error message for error: lines', () => {
    expect(() =>
      parseSseLine('error: {"message":"context window exceeded"}')
    ).toThrow('context window exceeded')
  })

  it('throws SyntaxError for malformed JSON in a data: line', () => {
    expect(() => parseSseLine('data: {not valid json}')).toThrow(SyntaxError)
  })

  it('throws SyntaxError for malformed JSON in an error: line', () => {
    expect(() => parseSseLine('error: {bad json}')).toThrow(SyntaxError)
  })

  it('handles CRLF leftover (\\r after trim)', () => {
    const chunk = parseSseLine(
      'data: {"id":"1","choices":[{"delta":{"content":"A"},"finish_reason":null}]}\r'
    )
    expect(chunk).not.toBeNull()
    expect(chunk!.choices?.[0]?.delta?.content).toBe('A')
  })

  it('treats data:{} without a space as an unknown field and returns null', () => {
    expect(parseSseLine('data:{"no":"space"}')).toBeNull()
  })

  it('checks only choices[0] for finish_reason; leaves other choices untouched', () => {
    const line =
      'data: {"choices":[{"delta":{"content":"a"},"finish_reason":null},{"delta":{"content":"b"},"finish_reason":"length"}]}'
    const chunk = parseSseLine(line)
    expect(chunk).not.toBeNull()
    expect(chunk!.choices?.[0]?.finish_reason).toBeNull()
  })
})

// ─── integration: simulated streaming pipeline ────────────────────────────

describe('simulated streaming pipeline', () => {
  function* consumeChunks(rawChunks: string[]): Generator<SseChunk> {
    let buffer = ''
    for (const raw of rawChunks) {
      const [lines, rem] = appendToBuffer(buffer, raw)
      buffer = rem
      for (const line of lines) {
        const chunk = parseSseLine(line)
        if (chunk) yield chunk
      }
    }
    if (buffer.trim()) {
      const chunk = parseSseLine(buffer)
      if (chunk) yield chunk
    }
  }

  it('handles a single SSE event arriving in one chunk', () => {
    const result = [
      ...consumeChunks([
        'data: {"id":"1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    ]
    expect(result).toHaveLength(1)
    expect(result[0].choices?.[0]?.delta?.content).toBe('Hello')
  })

  it('handles an event split across two chunk boundaries', () => {
    const result = [
      ...consumeChunks([
        'data: {"id":"1","choices":[{"delta":{"con',
        'tent":"Hi"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    ]
    expect(result).toHaveLength(1)
    expect(result[0].choices?.[0]?.delta?.content).toBe('Hi')
  })

  it('collects multiple events arriving in one large chunk', () => {
    const payload = [
      'data: {"id":"1","choices":[{"delta":{"content":"A"},"finish_reason":null}]}\n\n',
      'data: {"id":"2","choices":[{"delta":{"content":"B"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const result = [...consumeChunks([payload])]
    expect(result).toHaveLength(2)
    expect(result[0].choices?.[0]?.delta?.content).toBe('A')
    expect(result[1].choices?.[0]?.delta?.content).toBe('B')
  })

  it('collects events across many single-byte chunks', () => {
    const full =
      'data: {"id":"1","choices":[{"delta":{"content":"X"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
    const singleBytes = full.split('').map((c) => c)
    const result = [...consumeChunks(singleBytes)]
    expect(result).toHaveLength(1)
    expect(result[0].choices?.[0]?.delta?.content).toBe('X')
  })

  it('propagates OUT_OF_CONTEXT_SIZE when finish_reason is "length"', () => {
    expect(() =>
      [...consumeChunks([
        'data: {"id":"1","choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      ])]
    ).toThrow(OUT_OF_CONTEXT_SIZE)
  })

  it('propagates server error message from error: line', () => {
    expect(() =>
      [...consumeChunks([
        'data: {"id":"1","choices":[{"delta":{"content":"A"},"finish_reason":null}]}\n\n',
        'error: {"message":"upstream model crashed"}\n\n',
      ])]
    ).toThrow('upstream model crashed')
  })

  it('skips keepalive empty lines and SSE comments without yielding', () => {
    const result = [
      ...consumeChunks([
        ': keepalive\n\n',
        'data: {"id":"1","choices":[{"delta":{"content":"A"},"finish_reason":null}]}\n\n',
        '\n\n',
        'data: [DONE]\n\n',
      ]),
    ]
    expect(result).toHaveLength(1)
    expect(result[0].choices?.[0]?.delta?.content).toBe('A')
  })

  it('handles CRLF line endings throughout the stream', () => {
    const result = [
      ...consumeChunks([
        'data: {"id":"1","choices":[{"delta":{"content":"A"},"finish_reason":null}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ]),
    ]
    expect(result).toHaveLength(1)
    expect(result[0].choices?.[0]?.delta?.content).toBe('A')
  })

  it('yields multiple events split at irregular boundaries', () => {
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"conten',
      't":"A"},"finish_reason":null}]}\n\ndata: {"id":"2","choice',
      's":[{"delta":{"content":"B"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    ]
    const result = [...consumeChunks(chunks)]
    expect(result).toHaveLength(2)
    expect(result[0].choices?.[0]?.delta?.content).toBe('A')
    expect(result[1].choices?.[0]?.delta?.content).toBe('B')
  })
})
