import type { BCFDInteractionCommand } from '../types/types'
import {
  emptyPublicationState,
  type InteractionPublicationState,
  type PublicationError,
  type PublicationOperation
} from '../../shared/interactionPublication'
import { resourceRevision } from './resourceChangeService'

export interface InteractionPublishBackend {
  replace(guildId: string, commands: BCFDInteractionCommand[]): Promise<void>
  register(command: BCFDInteractionCommand): Promise<void>
  unregister(command: BCFDInteractionCommand): Promise<void>
  isCurrent(): boolean
}

export class PublicationFailure extends Error {
  constructor(public readonly feedback: PublicationError) {
    super(feedback.code)
  }
}

export function publicationError(error: unknown): PublicationError {
  if (error instanceof PublicationFailure) return error.feedback
  const code = (error as { code?: string | number })?.code
  if (code === 10004) return { code: 'server-missing' }
  if (code === 50001 || code === 50013) return { code: 'permissions' }
  if (['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(String(code))) {
    return { code: 'network' }
  }
  return { code: 'discord', detail: error instanceof Error ? error.message : String(error) }
}

export interface SubmittedPublication {
  commands: BCFDInteractionCommand[]
  registered: boolean
}

/** Only the exact submitted version may acquire the confirmed registration state. */
export function applyPublicationResults(
  current: BCFDInteractionCommand[],
  results: SubmittedPublication[]
): string[] {
  const applied: string[] = []
  const revision = (command: BCFDInteractionCommand) =>
    resourceRevision({ ...command, guildId: command.guildId || '', isRegistered: false })
  for (const result of results) {
    for (const submitted of result.commands) {
      const item = current.find((command) => command.id === submitted.id)
      if (item && revision(item) === revision(submitted)) {
        item.isRegistered = result.registered
        applied.push(item.id)
      }
    }
  }
  return applied
}

interface PublisherDependencies {
  read(): BCFDInteractionCommand[]
  backend(): InteractionPublishBackend
  commit(results: SubmittedPublication[], isCurrent: () => boolean): Promise<string[]>
}

/** One app-wide operation; views may come and go without owning its lifetime. */
export class InteractionPublisher {
  private state = emptyPublicationState()
  private sink?: (state: InteractionPublicationState) => void

  constructor(private readonly dependencies: PublisherDependencies) {}

  getState(): InteractionPublicationState {
    return structuredClone(this.state)
  }

  setEventSink(sink: (state: InteractionPublicationState) => void): void {
    this.sink = sink
  }

  private update(state: InteractionPublicationState): void {
    this.state = { ...state, revision: this.state.revision + 1 }
    this.sink?.(this.getState())
  }

  async publish(operation: PublicationOperation, commandId?: string) {
    if (this.state.busy) return { success: false, error: 'Publishing is already in progress' }
    const submitted = structuredClone(
      this.dependencies.read().filter((item) => operation === 'sync' || item.id === commandId)
    )
    this.update({
      ...emptyPublicationState(),
      operation,
      busy: true,
      pendingIds: submitted.map((item) => item.id)
    })
    const successful: SubmittedPublication[] = []
    try {
      if (operation !== 'sync' && submitted.length !== 1) {
        throw new PublicationFailure({ code: 'command-missing' })
      }
      const backend = this.dependencies.backend()
      const groups = new Map<string, BCFDInteractionCommand[]>()
      // Preserve Sync All's ability to submit an empty global command list.
      if (operation === 'sync') groups.set('', [])
      for (const command of submitted) {
        const scope = command.guildId || ''
        groups.set(scope, [...(groups.get(scope) || []), command])
      }
      for (const [guildId, commands] of groups) {
        let error: PublicationError | undefined
        try {
          if (!backend.isCurrent()) throw new PublicationFailure({ code: 'connection-changed' })
          if (operation === 'sync') {
            if (new Set(commands.map((command) => command.commandName)).size !== commands.length) {
              throw new PublicationFailure({ code: 'duplicate-names' })
            }
            await backend.replace(guildId, commands)
          } else {
            await backend[operation](commands[0])
          }
          successful.push({ commands, registered: operation !== 'unregister' })
        } catch (cause) {
          error = publicationError(cause)
        }
        this.update({
          ...this.state,
          targets: [
            ...this.state.targets,
            { guildId, commandIds: commands.map((c) => c.id), error }
          ]
        })
      }
      if (!backend.isCurrent()) throw new PublicationFailure({ code: 'connection-changed' })
      let applied: string[]
      try {
        applied = await this.dependencies.commit(successful, () => backend.isCurrent())
      } catch (error) {
        if (error instanceof PublicationFailure) throw error
        throw new PublicationFailure({ code: 'save-failed' })
      }
      this.update({
        ...this.state,
        staleIds: successful
          .flatMap((r) => r.commands.map((c) => c.id))
          .filter((id) => !applied.includes(id))
      })
    } catch (cause) {
      this.update({ ...this.state, error: publicationError(cause) })
    } finally {
      this.update({
        ...this.state,
        busy: false,
        completed: true,
        pendingIds: [],
        failedIds: this.state.error
          ? submitted.map((c) => c.id)
          : this.state.targets
              .filter((target) => target.error)
              .flatMap((target) => target.commandIds)
      })
    }
    return {
      success:
        !this.state.error &&
        !this.state.targets.some((target) => target.error) &&
        !this.state.staleIds.length,
      state: this.getState()
    }
  }
}
