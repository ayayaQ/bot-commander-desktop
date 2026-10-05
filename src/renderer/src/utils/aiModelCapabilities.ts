import type { ApiProtocol, ModelCapabilities } from '@ayayaq/vivi/providers/models'
import type { AiModelInfo, AiProvider } from '../../../shared/aiModelTypes'
export type { ChatReasoningEffort as ReasoningEffort } from '../../../shared/aiModelTypes'
export {
  reasoningChoices,
  reasoningConfigurationError,
  reasoningCapabilityLabel
} from '../../../shared/modelReasoningControls'

/** Never use a catalog from a different provider, endpoint or selected exact ID. */
export function selectedModelCapabilities(
  provider: AiProvider,
  protocol: ApiProtocol,
  modelId: string,
  models: AiModelInfo[],
  selected?: ModelCapabilities
): ModelCapabilities | undefined {
  if (modelCapabilitySnapshotMatches(selected, provider, protocol, modelId)) return selected
  return models.find(
    (model) =>
      model.id === modelId &&
      model.capabilities.provider === provider &&
      model.capabilities.protocol === protocol &&
      model.capabilities.id === modelId
  )?.capabilities
}

/** Latest request wins, including when settings change during an older request. */
export class ModelCatalogRequestGate {
  private generation = 0
  invalidate(): void {
    this.generation++
  }
  begin(): number {
    return ++this.generation
  }
  current(request: number): boolean {
    return request === this.generation
  }
}

interface CatalogSettings {
  aiProvider?: AiProvider
  openaiApiKey?: string
  openrouterApiKey?: string
}

export function catalogSettingsMatch(local: CatalogSettings, committed: CatalogSettings): boolean {
  const provider = local.aiProvider || 'openai'
  return (
    provider === (committed.aiProvider || 'openai') &&
    (provider === 'openrouter' ? local.openrouterApiKey || '' : local.openaiApiKey || '') ===
      (provider === 'openrouter' ? committed.openrouterApiKey || '' : committed.openaiApiKey || '')
  )
}

export function canRefreshModelCatalog(
  local: CatalogSettings,
  committed: CatalogSettings,
  status: { saving: boolean; unsaved: boolean }
): boolean {
  return !status.saving && !status.unsaved && catalogSettingsMatch(local, committed)
}

export function modelCapabilitySnapshotMatches(
  capabilities: ModelCapabilities | undefined,
  provider: AiProvider,
  protocol: ApiProtocol,
  id: string
): boolean {
  return (
    capabilities?.apiVersion === 1 &&
    capabilities.provider === provider &&
    capabilities.protocol === protocol &&
    capabilities.id === id
  )
}

/** Selected host snapshots are authoritative; account-backed facts expire exactly. */
export function currentSelectedCapabilities(
  capabilities: ModelCapabilities | undefined,
  provider: AiProvider,
  protocol: ApiProtocol,
  id: string,
  expiresAt?: number,
  now = Date.now()
): ModelCapabilities | undefined {
  if (expiresAt !== undefined && (!Number.isFinite(expiresAt) || now >= expiresAt)) return undefined
  return modelCapabilitySnapshotMatches(capabilities, provider, protocol, id)
    ? capabilities
    : undefined
}
