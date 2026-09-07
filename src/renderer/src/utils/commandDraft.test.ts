import { describe, expect, it } from 'vitest'
import { proxy } from 'svelte/internal/client'
import { decodeBCFDCommand } from '../../../shared/commandCodec'
import { cloneCommandDraft, commandDraftSignature } from './commandDraft'

function command() {
  return decodeBCFDCommand({
    id: 'original',
    command: '!hello',
    commandDescription: 'Greeting',
    type: 0,
    channelMessage: '',
    privateMessage: '',
    channelEmbed: { title: 'Channel title', footer: 'Channel footer' },
    privateEmbed: { title: 'Private title', footer: 'Private footer' }
  }).command
}

const actions = [{ type: 'sendChannelEmbed' }, { type: 'sendPrivateEmbed' }]

describe('command editor drafts', () => {
  it('discards embed edits without leaking them into a later list save', () => {
    // CommandList and CommandEditor both use Svelte deep state proxies.
    const commands = proxy([command()])
    const original = JSON.stringify(commands)
    const draft = proxy(cloneCommandDraft(commands[0]))

    draft.channelEmbed.title = 'Experimental channel title'
    draft.channelEmbed.footer = 'Experimental channel footer'
    draft.privateEmbed.title = 'Experimental private title'
    draft.privateEmbed.footer = 'Experimental private footer'

    // Cancel unmounts the draft; a later unrelated operation persists the list.
    expect(JSON.stringify(commands)).toBe(original)
    const reopened = cloneCommandDraft(commands[0])
    expect(reopened.channelEmbed.title).toBe('Channel title')
    expect(reopened.privateEmbed.title).toBe('Private title')
  })

  it('preserves all command data and saves embed edits only when the draft is committed', () => {
    const commands = proxy([command()])
    const draft = proxy(cloneCommandDraft(commands[0]))
    expect(draft).toEqual(commands[0])
    expect(draft.channelEmbed).not.toBe(commands[0].channelEmbed)
    expect(draft.privateEmbed).not.toBe(commands[0].privateEmbed)

    draft.channelEmbed.title = 'Saved title'
    commands[0] = draft
    expect(JSON.parse(JSON.stringify(commands))[0].channelEmbed.title).toBe('Saved title')
  })

  it('detects nested edits and becomes clean when they are reverted', () => {
    const draft = proxy(cloneCommandDraft(command()))
    const baseline = commandDraftSignature(draft, actions)
    expect(commandDraftSignature(draft, actions)).toBe(baseline)
    draft.privateEmbed.title = 'Changed'
    expect(commandDraftSignature(draft, actions)).not.toBe(baseline)
    draft.privateEmbed.title = 'Private title'
    expect(commandDraftSignature(draft, actions)).toBe(baseline)
  })

  it('detects added or removed actions even when their payload is unchanged', () => {
    const draft = command()
    const baseline = commandDraftSignature(draft, actions)
    expect(commandDraftSignature(draft, actions.slice(1))).not.toBe(baseline)
    expect(commandDraftSignature(draft, [...actions, { type: 'sendMessage' }])).not.toBe(baseline)
    expect(commandDraftSignature(draft, [...actions].reverse())).toBe(baseline)
  })

  it('detects changes to details and imported replacement commands', () => {
    const draft = command()
    const baseline = commandDraftSignature(draft, actions)
    draft.commandDescription = 'Changed description'
    expect(commandDraftSignature(draft, actions)).not.toBe(baseline)
    const imported = { ...command(), id: 'imported' }
    expect(commandDraftSignature(imported, actions)).not.toBe(baseline)
  })
})
