import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile } from 'svelte/compiler'

const settings = readFileSync('src/renderer/src/components/Settings.svelte', 'utf8')
const panel = readFileSync('src/renderer/src/components/AgentPanel.svelte', 'utf8')

function select(id: string): string {
  const match = settings.match(new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`))
  if (!match) throw new Error(`Missing settings control: ${id}`)
  return match[0]
}

describe('provider settings and enrollment controls', () => {
  it('compiles the settings and agent UI without a browser or provider calls', () => {
    for (const [filename, source] of [
      ['Settings.svelte', settings],
      ['AgentPanel.svelte', panel]
    ]) {
      expect(() => compile(source, { filename, generate: 'client' })).not.toThrow()
    }
  })

  it('offers only supported independent web and reviewer choices', () => {
    expect(select('web-provider').match(/<option value="[^"]+"/g)).toEqual([
      '<option value="disabled"',
      '<option value="deepseek"'
    ])
    expect(select('agent-reviewer-provider')).toContain('<option value="openai">')
    expect(select('agent-reviewer-provider')).toContain('<option value="openrouter">')
    expect(select('agent-reviewer-provider')).not.toContain('value="deepseek"')
    expect(select('deepseek-web-key-source')).toContain('<option value="separate">')
    expect(select('deepseek-web-key-source')).toContain('<option value="chat">')
  })

  it('keeps new keys transient and masked, with explicit narrow Save and Clear actions', () => {
    for (const key of ['deepseekApiKey', 'deepseekWebApiKey']) {
      expect(settings).not.toContain(`patchSettings({ ${key}`)
      expect(settings).not.toContain(`settings.${key}`)
    }
    for (const [id, value] of [
      ['deepseek-chat-key', 'deepseekKeyInput'],
      ['deepseek-web-key', 'deepseekWebKeyInput']
    ]) {
      const input = settings.match(new RegExp(`<input[^>]*id="${id}"[^>]*?/>`))?.[0]
      expect(input).toContain('type="password"')
      expect(input).toContain(`bind:value={${value}}`)
    }
    for (const purpose of ['chat', 'web']) {
      expect(settings).toContain(`updateDeepSeekCredential('${purpose}')`)
      expect(settings).toContain(`updateDeepSeekCredential('${purpose}', true)`)
    }
    expect(settings).toContain('await saveDeepSeekKey(')
    expect(settings).not.toMatch(/(?:title|data-tip)={[^}]*[Kk]ey/)
    expect(settings).not.toMatch(/(?:localStorage|sessionStorage)\.setItem/)
  })

  it('clears transient inputs after success or failure and when their account revision changes', () => {
    expect(settings).toMatch(
      /finally\s*{\s*if \(purpose === 'chat'\) deepseekKeyInput = ''\s*else deepseekWebKeyInput = ''/
    )
    expect(settings).toMatch(
      /deepseekChatAccountRevision !== settings.deepseekChatAccountRevision\)\s*deepseekKeyInput = ''/
    )
    expect(settings).toMatch(
      /deepseekWebAccountRevision !== settings.agentWebAccountRevision\)\s*deepseekWebKeyInput = ''/
    )
    expect(settings).toContain('Could not confirm the key update. Reload settings before retrying.')
  })

  // Auto activation and the separate web toggle are covered with real UI interactions in
  // scripts/test-agent-presentation-ui.mjs instead of checking dialog implementation strings.
})
