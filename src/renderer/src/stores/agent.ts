import { derived, get, writable } from 'svelte/store'
import type {
  AgentSession,
  AgentSessionsData,
  AgentStreamEvent,
  AgentToolCall
} from '../../../shared/agentTypes'
import { deriveAgentNavigationStatus, type AgentTerminalAttention } from '../utils/agentAttention'

const initial: AgentSessionsData = { sessions: [], activeSessionId: null }
export const agentSessions = writable<AgentSessionsData>(initial)
export const activeAgentSession = derived(
  agentSessions,
  ($data) => $data.sessions.find((session) => session.id === $data.activeSessionId) || null
)
export const unseenAgentResults = writable<Record<string, AgentTerminalAttention>>({})
export const agentNavigationStatus = derived(
  [agentSessions, unseenAgentResults],
  ([$data, $unseen]) => deriveAgentNavigationStatus($data.sessions, $unseen)
)

let cleanup: (() => void) | null = null
let initialization: Promise<void> | null = null
let agentViewActive = false

function replaceSession(session: AgentSession) {
  agentSessions.update((data) => ({
    ...data,
    sessions: data.sessions.some((item) => item.id === session.id)
      ? data.sessions.map((item) => (item.id === session.id ? session : item))
      : [session, ...data.sessions]
  }))
}

function updateTool(sessionId: string, toolCall: AgentToolCall) {
  agentSessions.update((data) => ({
    ...data,
    sessions: data.sessions.map((session) =>
      session.id !== sessionId
        ? session
        : {
            ...session,
            status:
              session.status === 'waiting_approval' && toolCall.status !== 'waiting_approval'
                ? 'running'
                : session.status,
            messages: session.messages.map((message) => ({
              ...message,
              toolCalls: message.toolCalls?.map((call) =>
                call.id === toolCall.id ? toolCall : call
              )
            }))
          }
    )
  }))
}

function handleEvent(_event: unknown, payload: AgentStreamEvent) {
  if (payload.session) replaceSession(payload.session)
  if (payload.message) {
    agentSessions.update((data) => ({
      ...data,
      sessions: data.sessions.map((session) =>
        session.id !== payload.sessionId
          ? session
          : {
              ...session,
              messages: session.messages.some((message) => message.id === payload.message!.id)
                ? session.messages
                : [...session.messages, payload.message!],
              updatedAt: payload.message!.timestamp
            }
      )
    }))
  }
  if (payload.toolCall) updateTool(payload.sessionId, payload.toolCall)
  const terminalStatus = payload.session?.status
  if (
    !agentViewActive &&
    (terminalStatus === 'completed' || terminalStatus === 'error') &&
    (payload.type === 'done' || payload.type === 'error')
  ) {
    unseenAgentResults.update((results) => ({
      ...results,
      [payload.sessionId]: terminalStatus
    }))
  }
}

export function initializeAgentSessions(): Promise<void> {
  if (initialization) return initialization
  if (!cleanup) {
    window.electron.ipcRenderer.on('agent:event', handleEvent)
    cleanup = () => window.electron.ipcRenderer.removeListener('agent:event', handleEvent)
  }
  initialization = window.electron.ipcRenderer.invoke('agent:list').then((data) => {
    agentSessions.set(data)
  })
  return initialization
}

export function destroyAgentListeners() {
  cleanup?.()
  cleanup = null
  initialization = null
}

export function setAgentViewActive(active: boolean) {
  agentViewActive = active
  window.electron.ipcRenderer.send('agent:view-state', active)
  if (active) unseenAgentResults.set({})
}

export async function createAgentSession() {
  const session: AgentSession = await window.electron.ipcRenderer.invoke('agent:create')
  agentSessions.update((data) => ({
    sessions: [session, ...data.sessions],
    activeSessionId: session.id
  }))
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
    return {
      sessions,
      activeSessionId:
        data.activeSessionId === sessionId ? sessions[0]?.id || null : data.activeSessionId
    }
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
