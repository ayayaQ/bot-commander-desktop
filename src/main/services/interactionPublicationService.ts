import { getInteractions, setInteractions } from './interactionService'
import { saveInteractions } from './fileService'
import { createInteractionPublishBackend } from './slashCommandRegistry'
import {
  InteractionPublisher,
  applyPublicationResults,
  PublicationFailure
} from './interactionPublisher'
import { emitResourceChanged, withResourceMutationLock } from './resourceChangeService'

/** App-wide owner shared by IPC and local readiness; reads never create a backend. */
export const interactionPublisher = new InteractionPublisher({
  read: getInteractions,
  backend: createInteractionPublishBackend,
  commit: (results, isCurrent) =>
    withResourceMutationLock('interactions', async () => {
      if (!isCurrent()) throw new PublicationFailure({ code: 'connection-changed' })
      const previous = getInteractions()
      const updated = structuredClone(previous)
      const applied = applyPublicationResults(updated, results)
      if (!applied.length) return applied
      await saveInteractions(updated)
      setInteractions(updated)
      emitResourceChanged('interactions', 'system', updated)
      return applied
    })
})

export function getInteractionPublicationObservation() {
  return {
    state: interactionPublisher.getState(),
    observedAt: interactionPublisher.getObservedAt()
  }
}
