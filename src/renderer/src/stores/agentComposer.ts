import { get, writable } from 'svelte/store'
import type { AgentSession } from '../../../shared/agentTypes'

interface ComposerDraft {
  content: string
  revision: number
  submitting: boolean
  error: string
}

// Keep drafts per session, including when the panel unmounts or a request finishes late.
export const agentDrafts = writable<Record<string, ComposerDraft>>({})

export function canSubmitAgentDraft(session: AgentSession): boolean {
  if (session.context?.state === 'compacting') return false
  if (session.planReady && session.mode === 'planning' && session.status === 'completed')
    return false
  const running = session.status === 'running' || session.status === 'waiting_approval'
  return !running || !!session.activeRunId
}

export function setAgentDraft(sessionId: string, content: string) {
  agentDrafts.update((drafts) => ({
    ...drafts,
    [sessionId]: {
      content,
      revision: (drafts[sessionId]?.revision || 0) + 1,
      submitting: drafts[sessionId]?.submitting || false,
      error: ''
    }
  }))
}

export async function submitAgentDraft(
  session: AgentSession,
  mode: 'queue' | 'interrupt' = 'queue'
): Promise<boolean> {
  const sessionId = session.id
  const runId = session.activeRunId
  const running = session.status === 'running' || session.status === 'waiting_approval'
  const draft = get(agentDrafts)[sessionId]
  if (!draft?.content.trim() || draft.submitting) return false
  if (!canSubmitAgentDraft(session)) return false
  if (!running && mode === 'interrupt') return false
  const revision = draft.revision
  const update = (patch: Partial<ComposerDraft>) =>
    agentDrafts.update((drafts) => ({
      ...drafts,
      [sessionId]: { ...drafts[sessionId], ...patch }
    }))
  update({ submitting: true, error: '' })
  try {
    if (running) {
      await window.electron.ipcRenderer.invoke(
        'agent:steer',
        sessionId,
        runId,
        draft.content.trim(),
        mode
      )
    } else {
      await window.electron.ipcRenderer.invoke('agent:send', sessionId, draft.content.trim())
    }
    // An edited draft is a new message, even if its text happens to match the submitted text.
    if (get(agentDrafts)[sessionId]?.revision === revision) update({ content: '' })
    return true
  } catch (error) {
    update({
      error: error instanceof Error ? error.message : 'Message could not be sent. Try again.'
    })
    return false
  } finally {
    update({ submitting: false })
  }
}
