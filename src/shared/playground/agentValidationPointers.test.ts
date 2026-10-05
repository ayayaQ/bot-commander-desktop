import { describe, expect, it } from 'vitest'
import { validateAgentValidationSuite } from './agentValidationFixtures'
import { createPlaygroundState } from './types'

function suite(path: string) {
  const state = createPlaygroundState()
  return {
    cases: [
      {
        name: 'reply',
        state,
        steps: [
          {
            kind: 'message',
            senderId: state.members[0].id,
            content: '!ping',
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path, equals: 'Pong!' }
            ]
          }
        ]
      }
    ]
  }
}

describe('validation assertion JSON Pointer syntax', () => {
  it.each([
    '/effects/messages/0/content',
    '/effects/',
    '/effects//content',
    '/effects/a~0b',
    '/effects/a~1b',
    '/effects/~01',
    '/effects/space and Unicode café'
  ])('accepts supported RFC 6901 pointer %s', (path) => {
    expect(validateAgentValidationSuite(suite(path)).cases[0].steps[0].assertions[1].path).toBe(
      path
    )
  })

  it.each([
    'effects/messages',
    '/other/messages',
    '/effectsExtra/messages',
    '/effects/~',
    '/effects/~2',
    '/effects/a~x/b',
    '/effects/~/content',
    '/effects/~10~'
  ])('rejects invalid or unsupported pointer %s', (path) => {
    expect(() => validateAgentValidationSuite(suite(path))).toThrow('supported JSON Pointer')
  })
})
