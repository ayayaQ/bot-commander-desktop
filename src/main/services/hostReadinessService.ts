import { readHostReadiness } from '../../shared/hostReadiness'
import { getCommands, getHostConnectionObservation } from './botService'
import { getInteractions } from './interactionService'
import { getInteractionPublicationObservation } from './interactionPublicationService'

/** Cached getters only: never load credentials or trigger hosting/publication/provider calls. */
export function readHostStatus() {
  return readHostReadiness(() => {
    const interactions = getInteractions()
    return {
      connection: getHostConnectionObservation(),
      commandCount: getCommands().bcfdCommands.length,
      interactionCount: interactions.length,
      localRegisteredCount: interactions.filter((item) => item.isRegistered === true).length,
      publication: getInteractionPublicationObservation()
    }
  })
}
