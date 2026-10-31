import { describe, expect, it } from 'vitest'
import { readOpenRouterDiagnostic } from './agentProviderError'

describe('bounded OpenRouter agent diagnostics', () => {
  it('extracts nested provider messages and redacts configured credentials without exposing metadata', async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: 'Provider returned error',
          metadata: {
            provider_name: 'Anthropic',
            flagged_input: 'Private conversation',
            raw: JSON.stringify({
              error: {
                message: 'Invalid signature with configured-key and sk-or-v1-other-secret',
                input: 'Private echoed input',
                headers: { Authorization: 'Private header' }
              }
            })
          }
        }
      }),
      { status: 400 }
    )
    expect(await readOpenRouterDiagnostic(response, ['configured-key'])).toBe(
      'Provider returned error; Invalid signature with [redacted] and [redacted]; Provider: Anthropic'
    )
    expect((await response.json()).error.metadata.flagged_input).toBe('Private conversation')
  })

  it.each(['<html>Gateway failure</html>', 'x'.repeat(65_537)])(
    'leaves malformed or oversized errors to the standard transport',
    async (body) => {
      expect(
        await readOpenRouterDiagnostic(new Response(body, { status: 400 }), [])
      ).toBeUndefined()
    }
  )

  it('does not surface arbitrary upstream text or retained metadata', async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: 'Bad request',
          metadata: { raw: 'Private raw body', flagged_input: 'Private input' }
        }
      }),
      { status: 400 }
    )
    expect(await readOpenRouterDiagnostic(response, [])).toBe('Bad request')
  })

  it('bounds displayed messages and removes control characters', async () => {
    const response = new Response(
      JSON.stringify({ error: { message: 'Bad\nrequest ' + 'x'.repeat(3000) } })
    )
    const detail = await readOpenRouterDiagnostic(response, [])
    expect(detail).toHaveLength(1000)
    expect(detail).toMatch(/^Bad request /)
  })

  it('stops reading an incomplete response when cancelled', async () => {
    const controller = new AbortController()
    const response = new Response(new ReadableStream())
    const pending = readOpenRouterDiagnostic(response, [], controller.signal)
    controller.abort()
    expect(await pending).toBeUndefined()
    void response.body!.cancel()
  })
})
