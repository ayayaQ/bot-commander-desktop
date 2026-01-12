import { BCFDInteractionCommand, BCFDInteractionButton } from '../types/types'

let interactions: BCFDInteractionCommand[] = []

export function getInteractions(): BCFDInteractionCommand[] {
  return interactions
}

export function setInteractions(newInteractions: BCFDInteractionCommand[]): void {
  interactions = newInteractions
}

export function findInteractionByCommandName(
  name: string
): BCFDInteractionCommand | undefined {
  return interactions.find((i) => i.commandName === name)
}

export function findInteractionByButtonId(customId: string):
  | {
      command: BCFDInteractionCommand
      button: BCFDInteractionButton
    }
  | undefined {
  for (const cmd of interactions) {
    const button = cmd.buttons.find((b) => b.customId === customId)
    if (button) {
      return { command: cmd, button }
    }
  }
  return undefined
}

export function findInteractionById(id: string): BCFDInteractionCommand | undefined {
  return interactions.find((i) => i.id === id)
}
