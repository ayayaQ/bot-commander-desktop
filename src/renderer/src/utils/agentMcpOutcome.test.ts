import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component as SvelteComponent } from 'svelte'
import * as server from 'svelte/internal/server'
import type { AgentToolCall } from '../../../shared/agentTypes'
import {
  displayAgentMcpResult,
  isAgentMcpErrorResult,
  MCP_RESULT_DISPLAY_LIMIT
} from './agentMcpOutcome'

describe('MCP result presentation', () => {
  it('preserves long returned text beyond the ordinary 24,000-character clipping boundary', () => {
    const result = {
      success: false,
      source: 'mcp',
      untrusted: true,
      content: [{ type: 'text', text: 'x'.repeat(40000) }],
      unknownOutcome: true,
      doNotRetry: true
    }
    const display = displayAgentMcpResult(result)
    expect(display.truncated).toBe(false)
    expect(display.text).toContain('x'.repeat(40000))
    expect(display.text).toContain('"unknownOutcome": true')
    expect(display.text).toContain('"doNotRetry": true')
  })
  it('falls back to compact JSON for dense structured data whose pretty format exceeds the host bound', () => {
    const result = {
      success: true,
      source: 'mcp',
      untrusted: true,
      structuredContent: Array.from({ length: 1000 }, (_, index) => ({
        index,
        values: [1, 2, 3, 4]
      }))
    }
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(
      MCP_RESULT_DISPLAY_LIMIT
    )
    expect(new TextEncoder().encode(JSON.stringify(result, null, 2)).length).toBeGreaterThan(
      MCP_RESULT_DISPLAY_LIMIT
    )
    expect(displayAgentMcpResult(result)).toEqual({
      text: JSON.stringify(result),
      truncated: false
    })
  })
  it('retains a near-bound accepted projection and terminal markers when pretty printing would overflow', () => {
    const result = {
      success: false,
      source: 'mcp',
      untrusted: true,
      content: 'x'.repeat(62000),
      structuredContent: Array(1000).fill(0),
      unknownOutcome: true,
      doNotRetry: true,
      checkpointUnconfirmed: true
    }
    const compact = JSON.stringify(result)
    expect(new TextEncoder().encode(compact).length).toBeGreaterThan(64000)
    expect(new TextEncoder().encode(compact).length).toBeLessThanOrEqual(MCP_RESULT_DISPLAY_LIMIT)
    expect(new TextEncoder().encode(JSON.stringify(result, null, 2)).length).toBeGreaterThan(
      MCP_RESULT_DISPLAY_LIMIT
    )
    const display = displayAgentMcpResult(result)
    expect(display).toEqual({ text: compact, truncated: false })
    expect(JSON.parse(display.text)).toMatchObject({
      unknownOutcome: true,
      doNotRetry: true,
      checkpointUnconfirmed: true
    })
  })
  it('bounds oversized display while reporting truncation separately', () => {
    const display = displayAgentMcpResult({ content: 'x'.repeat(100000) })
    expect(display.text.length).toBe(MCP_RESULT_DISPLAY_LIMIT)
    expect(display.truncated).toBe(true)
  })
  it('bounds multibyte text without splitting UTF-8 characters', () => {
    const display = displayAgentMcpResult({ content: 'あ'.repeat(100000) })
    expect(new TextEncoder().encode(display.text).length).toBeLessThanOrEqual(
      MCP_RESULT_DISPLAY_LIMIT
    )
    expect(display.text).not.toContain('�')
    expect(display.truncated).toBe(true)
  })
  it('keeps confirmed errors as JSON rather than hiding them behind a generic error line', () => {
    const result = {
      success: false,
      source: 'mcp',
      error: { code: 'fixture_error', message: 'Confirmed fixture error' }
    }
    expect(isAgentMcpErrorResult(result)).toBe(true)
    expect(displayAgentMcpResult(result).text).toContain('fixture_error')
    expect(isAgentMcpErrorResult({ success: true })).toBe(false)
    expect(isAgentMcpErrorResult(null)).toBe(false)
  })
  it('fails safely on a non-JSON result', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(displayAgentMcpResult(cyclic)).toEqual({
      text: 'Result details could not be displayed as JSON.',
      truncated: false
    })
  })
  it('renders result JSON as escaped wrapped scrollable plain text with independent host warnings', () => {
    const source = readFileSync(
      new URL('../components/AgentMcpOutcome.svelte', import.meta.url),
      'utf8'
    )
    const compiled = compile(source, { generate: 'server' }).js.code
    expect(source).not.toContain('{@html')
    expect(compiled).toContain('$.escape(display().text)')
    expect(source).toContain('max-h-64 overflow-auto whitespace-pre-wrap break-all')
    expect(source.indexOf("mcp.outcome === 'unknown'")).toBeLessThan(
      source.indexOf("mcp.outcome === 'not-sent'")
    )
    expect(source).toContain('Do not retry automatically')
    expect(source).toContain('External request was not attempted')
    expect(source).toContain('Outcome checkpointing is unconfirmed')
    expect(source.indexOf('Outcome checkpointing is unconfirmed')).toBeLessThan(
      source.indexOf('<details>')
    )
  })
})

describe('MCP outcome actual server-rendered component', () => {
  const source = readFileSync(
    new URL('../components/AgentMcpOutcome.svelte', import.meta.url),
    'utf8'
  )
  const generated = compile(source, { generate: 'server' })
    .js.code.replace(/^import .*;$/gm, '')
    .replace('export default function', 'return function')
  // Execute only the locally compiled component; returned server text is passed as data.
  const Component = new Function('$', 'displayAgentMcpResult', 'isAgentMcpErrorResult', generated)(
    server,
    displayAgentMcpResult,
    isAgentMcpErrorResult
  ) as SvelteComponent<{ mcp: AgentToolCall['mcp']; result?: unknown }>
  const mcp = (
    patch: Partial<NonNullable<AgentToolCall['mcp']>> = {}
  ): NonNullable<AgentToolCall['mcp']> => ({
    runId: 'fixture-run',
    operationDigest: 'fixture-operation',
    serverId: 'fixture',
    catalogKind: 'tools',
    remoteKey: 'fixture_tool',
    outcome: 'confirmed',
    requestSent: true,
    ...patch
  })
  it('shows confirmed error projection even with untrusted HTML-like returned text', () => {
    const body = render(Component, {
      props: {
        mcp: mcp(),
        result: {
          success: false,
          error: { code: 'fixture_server_error', message: '<script>fixture</script>' }
        }
      }
    }).body
    expect(body).toContain('External error response confirmed')
    expect(body).toContain('MCP result / error details')
    expect(body).toContain('fixture_server_error')
    expect(body).toContain('&lt;script>fixture&lt;/script>')
    expect(body).not.toContain('<script>fixture</script>')
  })
  it('unknown wins over contradictory not-sent data and checkpoint warnings stay outside details', () => {
    const body = render(Component, {
      props: {
        mcp: mcp({ outcome: 'unknown', requestSent: false, checkpointUnconfirmed: true }),
        result: { unknownOutcome: true, doNotRetry: true }
      }
    }).body
    expect(body).toContain('External outcome is unknown')
    expect(body).not.toContain('External request was not attempted')
    expect(body.indexOf('Do not retry automatically')).toBeLessThan(body.indexOf('<details>'))
    expect(body.indexOf('Outcome checkpointing is unconfirmed')).toBeLessThan(
      body.indexOf('<details>')
    )
  })
  it('shows an explicit not-attempted outcome without unknown warning', () => {
    const body = render(Component, {
      props: {
        mcp: mcp({ outcome: 'not-sent', requestSent: false }),
        result: { requestSent: false }
      }
    }).body
    expect(body).toContain('External request was not attempted')
    expect(body).not.toContain('External outcome is unknown')
  })
  it('retains known confirmed output under failed checkpoint and warns independently', () => {
    const body = render(Component, {
      props: {
        mcp: mcp({ checkpointUnconfirmed: true }),
        result: { success: true, content: 'Confirmed response retained' }
      }
    }).body
    expect(body).toContain('External response confirmed')
    expect(body).toContain('Confirmed response retained')
    expect(body).toContain('Outcome checkpointing is unconfirmed')
  })
})
