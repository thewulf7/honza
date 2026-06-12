import { describe, expect, it } from 'vitest'
import { OUT_OF_CONTEXT_SIZE, appendToBuffer, parseSseLine } from './sse'

describe('appendToBuffer', () => {
  it('returns complete lines and keeps the partial tail', () => {
    const [lines, rest] = appendToBuffer('', 'data: a\ndata: b\ndata: c')
    expect(lines).toEqual(['data: a', 'data: b'])
    expect(rest).toBe('data: c')
  })

  it('joins the previous remainder with the new chunk', () => {
    const [lines, rest] = appendToBuffer('data: {"x":', '1}\n')
    expect(lines).toEqual(['data: {"x":1}'])
    expect(rest).toBe('')
  })

  it('drops blank separator lines', () => {
    const [lines] = appendToBuffer('', 'data: a\n\n\ndata: b\n')
    expect(lines).toEqual(['data: a', 'data: b'])
  })

  it('strips CRLF line endings', () => {
    const [lines, rest] = appendToBuffer('', 'data: a\r\ndata: b\r\n')
    expect(lines).toEqual(['data: a', 'data: b'])
    expect(rest).toBe('')
  })

  it('returns no lines when the chunk has no newline', () => {
    const [lines, rest] = appendToBuffer('', 'data: partial')
    expect(lines).toEqual([])
    expect(rest).toBe('data: partial')
  })

  it('handles a chunk that is exactly one line', () => {
    const [lines, rest] = appendToBuffer('', 'data: [DONE]\n')
    expect(lines).toEqual(['data: [DONE]'])
    expect(rest).toBe('')
  })

  it('survives an empty chunk', () => {
    const [lines, rest] = appendToBuffer('carry', '')
    expect(lines).toEqual([])
    expect(rest).toBe('carry')
  })
})

describe('parseSseLine', () => {
  it('parses a data line into its JSON payload', () => {
    const chunk = parseSseLine(
      'data: {"choices":[{"delta":{"content":"hi"}}]}'
    ) as any
    expect(chunk.choices[0].delta.content).toBe('hi')
  })

  it('accepts data lines without a space after the colon', () => {
    const chunk = parseSseLine('data:{"id":"x"}') as any
    expect(chunk.id).toBe('x')
  })

  it('returns null for [DONE]', () => {
    expect(parseSseLine('data: [DONE]')).toBeNull()
  })

  it('returns null for empty payloads', () => {
    expect(parseSseLine('data:')).toBeNull()
  })

  it('returns null for comments and other SSE fields', () => {
    expect(parseSseLine(': keep-alive')).toBeNull()
    expect(parseSseLine('event: message')).toBeNull()
    expect(parseSseLine('id: 42')).toBeNull()
  })

  it('throws SyntaxError on malformed JSON', () => {
    expect(() => parseSseLine('data: {not json')).toThrow(SyntaxError)
  })

  it('throws the context-size sentinel on length finish reason', () => {
    expect(() =>
      parseSseLine('data: {"choices":[{"finish_reason":"length"}]}')
    ).toThrow(OUT_OF_CONTEXT_SIZE)
  })

  it('does not throw for normal finish reasons', () => {
    const chunk = parseSseLine(
      'data: {"choices":[{"finish_reason":"stop"}]}'
    ) as any
    expect(chunk.choices[0].finish_reason).toBe('stop')
  })

  it('throws when the payload carries a string error', () => {
    expect(() => parseSseLine('data: {"error":"boom"}')).toThrow('boom')
  })

  it('throws the error message when the payload carries an error object', () => {
    expect(() =>
      parseSseLine('data: {"error":{"message":"bad request","code":400}}')
    ).toThrow('bad request')
  })
})
