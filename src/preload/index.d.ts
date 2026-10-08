import { ExposedElectronAPI } from '../renderer/src/env'

// Publication state is shared by invoke('get-interaction-publication') and
// the 'interactions:publication' receive channel on the whitelisted IPC bridge.
export type {
  SelectedModelCapabilityRequest,
  SelectedModelCapabilitySnapshot
} from '../shared/aiModelTypes'
export type { ModelCapabilities } from '@ayayaq/vivi/providers/models'
export type { InteractionPublicationState } from '../shared/interactionPublication'
export type { AgentAutoReviewEnrollment, AgentDecisionDisplay } from '../shared/agentAutoReview'

declare global {
  interface Window {
    electron: ExposedElectronAPI
    api: unknown
  }
}
