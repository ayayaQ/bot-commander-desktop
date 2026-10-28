import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { AgentSession } from '../../../shared/agentTypes'
import { agentDrafts, canSubmitAgentDraft, setAgentDraft, submitAgentDraft } from './agentComposer'

const session = (id = 'session-a', running = true): AgentSession => ({
  id,
  title: id,
  mode: 'manual',
  model: 'fixture',
  reasoningEffort: 'none',
  status: running ? 'running' : 'idle',
  activeRunId: running ? 'run-a' : undefined,
  messages: [],
  history: [],
  createdAt: '',
  updatedAt: '',
  planReady: false,
  tokenCount: 0
})

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('agent steering composer', () => {
  const invoke = vi.fn()
  beforeEach(() => {
    agentDrafts.set({})
    invoke.mockReset().mockResolvedValue({ runId: 'run-a' })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each(['queue', 'interrupt'] as const)(
    'sends %s with the captured session and run',
    async (mode) => {
      setAgentDraft('session-a', '  Follow this direction  ')
      expect(await submitAgentDraft(session(), mode)).toBe(true)
      expect(invoke).toHaveBeenCalledWith(
        'agent:steer',
        'session-a',
        'run-a',
        'Follow this direction',
        mode
      )
      expect(get(agentDrafts)['session-a'].content).toBe('')
      expect(invoke.mock.calls.some(([channel]) => channel === 'agent:cancel')).toBe(false)
    }
  )

  it('uses the existing send contract when idle', async () => {
    setAgentDraft('session-a', 'Start work')
    await submitAgentDraft(session('session-a', false))
    expect(invoke).toHaveBeenCalledWith('agent:send', 'session-a', 'Start work')
  })

  it('preserves input before acknowledgement and prevents duplicate pending submissions', async () => {
    const response = deferred()
    invoke.mockReturnValue(response.promise)
    setAgentDraft('session-a', 'Direction')
    const pending = submitAgentDraft(session())
    expect(get(agentDrafts)['session-a'].content).toBe('Direction')
    expect(get(agentDrafts)['session-a'].submitting).toBe(true)
    expect(await submitAgentDraft(session(), 'interrupt')).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
    response.resolve({ runId: 'run-a' })
    await pending
    expect(get(agentDrafts)['session-a'].content).toBe('')
    expect(get(agentDrafts)['session-a'].submitting).toBe(false)
  })

  it('preserves the exact input and exposes failures without retrying', async () => {
    invoke.mockRejectedValue(new Error('Run changed; retry'))
    setAgentDraft('session-a', '  Keep my draft  ')
    expect(await submitAgentDraft(session())).toBe(false)
    expect(get(agentDrafts)['session-a']).toMatchObject({
      content: '  Keep my draft  ',
      error: 'Run changed; retry',
      submitting: false
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps later edits and other session drafts when an old response arrives', async () => {
    const response = deferred()
    invoke.mockReturnValue(response.promise)
    setAgentDraft('session-a', 'Original')
    const target = session()
    const pending = submitAgentDraft(target)
    target.activeRunId = 'run-b'
    setAgentDraft('session-b', 'Another session')
    setAgentDraft('session-a', 'New draft')
    response.resolve({ runId: 'run-a' })
    await pending
    expect(invoke).toHaveBeenCalledWith('agent:steer', 'session-a', 'run-a', 'Original', 'queue')
    expect(get(agentDrafts)['session-a'].content).toBe('New draft')
    expect(get(agentDrafts)['session-b'].content).toBe('Another session')
  })

  it('does not erase a new draft even when its text matches the submitted message', async () => {
    const response = deferred()
    invoke.mockReturnValue(response.promise)
    setAgentDraft('session-a', 'Original')
    const pending = submitAgentDraft(session())
    setAgentDraft('session-a', '')
    setAgentDraft('session-a', 'Original')
    response.resolve({ runId: 'run-a' })
    await pending
    expect(get(agentDrafts)['session-a'].content).toBe('Original')
  })

  it('never steers a missing run or interrupts an idle session', async () => {
    setAgentDraft('session-a', 'Direction')
    expect(await submitAgentDraft({ ...session(), activeRunId: undefined })).toBe(false)
    expect(await submitAgentDraft(session('session-a', false), 'interrupt')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('can queue while waiting for approval without resolving approval', async () => {
    setAgentDraft('session-a', 'Direction')
    await submitAgentDraft({ ...session(), status: 'waiting_approval' })
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'agent:steer',
      'session-a',
      'run-a',
      'Direction',
      'queue'
    )
  })

  it.each(['manual', 'auto', 'planning'] as const)(
    'queues %s guidance without changing the session mode or approval state',
    async (mode) => {
      const target = { ...session(), mode }
      setAgentDraft(target.id, 'Adjust the approach')
      expect(await submitAgentDraft(target)).toBe(true)
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        'agent:steer',
        target.id,
        target.activeRunId,
        'Adjust the approach',
        'queue'
      )
      expect(target.mode).toBe(mode)
      expect(target.status).toBe('running')
    }
  )

  it.each([true, false])(
    'preserves drafts during automatic or explicit context compaction (running=%s)',
    async (running) => {
      const target: AgentSession = {
        ...session('session-a', running),
        context: { provider: 'openai', model: 'fixture', state: 'compacting' }
      }
      setAgentDraft(target.id, 'Keep this for after compaction')
      expect(canSubmitAgentDraft(target)).toBe(false)
      expect(await submitAgentDraft(target)).toBe(false)
      expect(await submitAgentDraft(target, 'interrupt')).toBe(false)
      expect(invoke).not.toHaveBeenCalled()
      expect(get(agentDrafts)[target.id].content).toBe('Keep this for after compaction')
      target.context.state = 'ready'
      expect(canSubmitAgentDraft(target)).toBe(true)
      expect(await submitAgentDraft(target)).toBe(true)
    }
  )

  it('requires the existing decision flow for a completed plan', async () => {
    const target: AgentSession = {
      ...session('session-a', false),
      mode: 'planning',
      status: 'completed',
      planReady: true
    }
    setAgentDraft(target.id, 'Implement it')
    expect(canSubmitAgentDraft(target)).toBe(false)
    expect(await submitAgentDraft(target)).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
    expect(get(agentDrafts)[target.id].content).toBe('Implement it')
  })
})
