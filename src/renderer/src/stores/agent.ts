import { derived, get, writable } from 'svelte/store'
import type {
  AgentSession,
  AgentSessionsData,
  AgentStreamEvent,
  AgentToolCall
} from '../../../shared/agentTypes'

const initial: AgentSessionsData = { sessions: [], activeSessionId: null }
export const agentSessions = writable<AgentSessionsData>(initial)
export const activeAgentSession = derived(agentSessions, ($data) =>
  $data.sessions.find((session) => session.id === $data.activeSessionId) || null
)

let cleanup: (() => void) | null = null

function replaceSession(session: AgentSession) {
  agentSessions.update((data) => ({
    ...data,
    sessions: data.sessions.some((item) => item.id === session.id)
      ? data.sessions.map((item) => item.id === session.id ? session : item)
      : [session, ...data.sessions]
  }))
}

function updateTool(sessionId: string, toolCall: AgentToolCall) {
  agentSessions.update((data) => ({
    ...data,
    sessions: data.sessions.map((session) => session.id !== sessionId ? session : {
      ...session,
      messages: session.messages.map((message) => ({
        ...message,
        toolCalls: message.toolCalls?.map((call) => call.id === toolCall.id ? toolCall : call)
      }))
    })
  }))
}

function handleEvent(_event: unknown, payload: AgentStreamEvent) {
  if (payload.session) replaceSession(payload.session)
  if (payload.message) {
    agentSessions.update((data) => ({
      ...data,
      sessions: data.sessions.map((session) => session.id !== payload.sessionId ? session : {
        ...session,
        messages: session.messages.some((message) => message.id === payload.message!.id)
          ? session.messages
          : [...session.messages, payload.message!],
        updatedAt: payload.message!.timestamp
      })
    }))
  }
  if (payload.toolCall) updateTool(payload.sessionId, payload.toolCall)
}

export async function initializeAgentSessions() {
  agentSessions.set(await window.electron.ipcRenderer.invoke('agent:list'))
  if (!cleanup) {
    window.electron.ipcRenderer.on('agent:event', handleEvent)
    cleanup = () => window.electron.ipcRenderer.removeListener('agent:event', handleEvent)
  }
}

export function destroyAgentListeners() {
  cleanup?.()
  cleanup = null
}

export async function createAgentSession() {
  const session: AgentSession = await window.electron.ipcRenderer.invoke('agent:create')
  agentSessions.update((data) => ({ sessions: [session, ...data.sessions], activeSessionId: session.id }))
  return session
}

export async function selectAgentSession(sessionId: string) {
  agentSessions.update((data) => ({ ...data, activeSessionId: sessionId }))
  await window.electron.ipcRenderer.invoke('agent:set-active', sessionId)
}

export async function deleteAgentSession(sessionId: string) {
  await window.electron.ipcRenderer.invoke('agent:delete', sessionId)
  agentSessions.update((data) => {
    const sessions = data.sessions.filter((session) => session.id !== sessionId)
    return { sessions, activeSessionId: data.activeSessionId === sessionId ? sessions[0]?.id || null : data.activeSessionId }
  })
}

export async function updateAgentSession(sessionId: string, updates: Partial<AgentSession>) {
  const session = await window.electron.ipcRenderer.invoke('agent:update', sessionId, updates)
  replaceSession(session)
}

export async function sendAgentMessage(content: string) {
  const session = get(activeAgentSession)
  if (!session) return
  await window.electron.ipcRenderer.invoke('agent:send', session.id, content)
}

export async function resolveAgentApproval(toolCallId: string, approved: boolean) {
  const session = get(activeAgentSession)
  if (!session) return
  await window.electron.ipcRenderer.invoke('agent:approve', session.id, toolCallId, approved)
}

export async function cancelAgentRun() {
  const session = get(activeAgentSession)
  if (!session) return
  await window.electron.ipcRenderer.invoke('agent:cancel', session.id)
}
