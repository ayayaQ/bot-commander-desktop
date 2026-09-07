import { ExposedElectronAPI } from '../renderer/src/env'

// Publication state is shared by invoke('get-interaction-publication') and
// the 'interactions:publication' receive channel on the whitelisted IPC bridge.
export type { InteractionPublicationState } from '../shared/interactionPublication'

declare global {
  interface Window {
    electron: ExposedElectronAPI
    api: unknown
  }
}
