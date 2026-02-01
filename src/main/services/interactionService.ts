import {
  BCFDInteractionCommand,
  BCFDInteractionButton,
  BCFDInteractionAction
} from '../types/types'

let interactions: BCFDInteractionCommand[] = []

export function getInteractions(): BCFDInteractionCommand[] {
  return interactions
}

export function setInteractions(newInteractions: BCFDInteractionCommand[]): void {
  interactions = newInteractions
}

export function findInteractionByCommandName(name: string): BCFDInteractionCommand | undefined {
  return interactions.find((i) => i.commandName === name)
}

// Helper function to recursively search for a button in an action's nested buttons
function findButtonInAction(
  action: BCFDInteractionAction,
  customId: string
): BCFDInteractionButton | undefined {
  if (!action.buttons) return undefined

  for (const button of action.buttons) {
    if (button.customId === customId) {
      return button
    }
    // Recursively search in this button's action
    const nestedButton = findButtonInAction(button.action, customId)
    if (nestedButton) {
      return nestedButton
    }
  }
  return undefined
}

export function findInteractionByButtonId(customId: string):
  | {
      command: BCFDInteractionCommand
      button: BCFDInteractionButton
    }
  | undefined {
  for (const cmd of interactions) {
    // Check root level buttons

    const button = findButtonInAction(cmd.rootAction, customId)
    if (button) {
      return { command: cmd, button }
    }
  }
  return undefined
}

export function findInteractionById(id: string): BCFDInteractionCommand | undefined {
  return interactions.find((i) => i.id === id)
}
