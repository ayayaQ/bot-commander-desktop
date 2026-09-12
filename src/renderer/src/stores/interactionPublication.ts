import { get, writable } from 'svelte/store'
import {
  emptyPublicationState,
  type InteractionPublicationState,
  type PublicationOperation
} from '../../../shared/interactionPublication'

export const interactionPublication = writable(emptyPublicationState())
export const publicationRequestPending = writable(false)
export const publicationTransportError = writable('')

function receive(state: InteractionPublicationState) {
  if (state.revision >= get(interactionPublication).revision) interactionPublication.set(state)
}

export function initializeInteractionPublication(): () => void {
  const ipc = window.electron.ipcRenderer
  ipc.on('interactions:publication', receive)
  void ipc
    .invoke('get-interaction-publication')
    .then(receive)
    .catch((error) => {
      publicationTransportError.set(String(error))
    })
  return () => ipc.removeListener('interactions:publication', receive)
}

export async function publishInteractions(operation: PublicationOperation, commandId?: string) {
  if (get(interactionPublication).busy || get(publicationRequestPending)) return
  publicationRequestPending.set(true)
  publicationTransportError.set('')
  try {
    const channel = operation === 'sync' ? 'sync-all-slash-commands' : `${operation}-slash-command`
    const result = await window.electron.ipcRenderer.invoke(channel, commandId)
    if (result.state) receive(result.state)
    else if (result.error) publicationTransportError.set(result.error)
  } catch (error) {
    publicationTransportError.set(String(error))
  } finally {
    publicationRequestPending.set(false)
  }
}
