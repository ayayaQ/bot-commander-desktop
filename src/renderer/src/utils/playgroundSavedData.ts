import { snapshotCommands, snapshotInteractions } from '../../../shared/playground/snapshots'
import type { BCFDCommand, BCFDInteractionCommand } from '../types/types'

export class PlaygroundSavedData {
  private generation = 0
  cancel(): void {
    this.generation++
  }

  async load(
    invoke: (channel: string) => Promise<unknown>
  ): Promise<
    | { commands: BCFDCommand[]; interactions: BCFDInteractionCommand[]; errors: string[] }
    | undefined
  > {
    const generation = ++this.generation
    const [commands, interactions] = await Promise.allSettled([
      invoke('get-commands'),
      invoke('get-interactions')
    ])
    if (generation !== this.generation) return undefined
    const result = {
      commands: [] as BCFDCommand[],
      interactions: [] as BCFDInteractionCommand[],
      errors: [] as string[]
    }
    try {
      if (commands.status === 'rejected') throw commands.reason
      result.commands = snapshotCommands(commands.value)
    } catch (error) {
      result.errors.push(
        `Commands: ${error instanceof Error ? error.message : 'Unable to read saved commands'}`
      )
    }
    try {
      if (interactions.status === 'rejected') throw interactions.reason
      result.interactions = snapshotInteractions(interactions.value)
    } catch (error) {
      result.errors.push(
        `Interactions: ${error instanceof Error ? error.message : 'Unable to read saved interactions'}`
      )
    }
    return result
  }
}
