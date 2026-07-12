import { describe, expect, it } from 'vitest'
import { diffAgentApproval } from './agentApprovalDiff'

describe('agent approval diff', () => {
  it('returns only changed nested fields with readable labels', () => {
    const changes = diffAgentApproval(
      { command: 'ping', channelEmbed: { title: 'Old', description: '' }, enabled: false },
      { command: 'ping', channelEmbed: { title: 'New', description: '' }, enabled: true }
    )

    expect(changes).toEqual([
      expect.objectContaining({ path: '/channelEmbed/title', label: 'Channel Embed / Title', before: 'Old', after: 'New' }),
      expect.objectContaining({ path: '/enabled', label: 'Enabled', before: false, after: true })
    ])
  })

  it('suppresses empty defaults for newly created resources', () => {
    const changes = diffAgentApproval(null, {
      id: 'generated', command: 'hello', commandDescription: 'Greets users', type: 0,
      channelMessage: '', deleteAfter: false, deleteNum: 0, actionArr: [false, false]
    })

    expect(changes.map((change) => change.path)).toEqual([
      '/command', '/commandDescription', '/type'
    ])
  })

  it('shows arrays as a single field comparison', () => {
    const changes = diffAgentApproval({ options: ['one'] }, { options: ['one', 'two'] })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ path: '/options', before: ['one'], after: ['one', 'two'] })
  })
})
