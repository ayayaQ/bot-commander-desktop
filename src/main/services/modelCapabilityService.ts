import { createHash } from 'node:crypto'
import {
  normalizeModelCapabilities,
  type ApiProtocol,
  type ModelCapabilities
} from '@ayayaq/vivi/providers/models'
import { onSettingsChanged } from './settingsService'
import type { AiProvider, SelectedModelCapabilitySnapshot } from '../../shared/aiModelTypes'
import { openAiResponsesExclusionSources } from './openAiResponsesExclusionSources'
import { openAiChatEvidence } from './openAiChatEvidence'
import { nonConversationOpenAI, openaiCapabilities } from './openAiResponsesRegistry'

// Exact alias and snapshot, both endpoints explicitly documented on the model page.
const DEFAULT_NANO_IDS = new Set(['gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17'])

/** Host Responses registry is retained only where the shared release has no fact. */
function resolveModelCapabilities(
  provider: AiProvider,
  protocol: ApiProtocol,
  model: unknown
): ModelCapabilities {
  const shared = normalizeModelCapabilities({ apiVersion: 1, provider, protocol, model })
  if (provider === 'openai' && DEFAULT_NANO_IDS.has(shared.id)) {
    return {
      ...shared,
      chat: 'supported',
      tools: 'supported',
      stream: 'supported',
      reasoning: {
        support: 'supported',
        disable: 'supported',
        effortSelection: 'supported',
        efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        requirement: 'optional'
      },
      sources: [
        {
          kind: 'official-model-documentation',
          url: 'https://developers.openai.com/api/docs/models/gpt-5.4-nano',
          reviewedOn: '2026-10-05'
        }
      ]
    }
  }
  if (provider === 'openai' && protocol === 'chat-completions') {
    const verified = openAiChatEvidence[shared.id]
    if (!verified) return shared
    const { url, ...facts } = verified
    return {
      ...shared,
      ...facts,
      reasoning: { ...facts.reasoning, efforts: [...facts.reasoning.efforts] },
      sources: [{ kind: 'official-model-documentation', url, reviewedOn: '2026-10-05' }]
    }
  }
  if (provider !== 'openai' || protocol !== 'responses') return shared
  const documented = openaiCapabilities[shared.id]
  if (nonConversationOpenAI.has(shared.id) && shared.chat === 'unknown') {
    return {
      ...shared,
      chat: 'unsupported',
      // Exact verified exclusions include specialized output/API-only/removed models,
      // not just an endpoint cell. Receipt mappings never synthesize model URLs.
      sources: openAiResponsesExclusionSources[shared.id]
        ? [openAiResponsesExclusionSources[shared.id]]
        : []
    }
  }
  if (!documented) return shared
  const knownEfforts = documented.efforts.length > 0
  const reasoning = {
    support: knownEfforts ? ('supported' as const) : ('unknown' as const),
    disable: knownEfforts
      ? documented.efforts.includes('none')
        ? ('supported' as const)
        : ('unsupported' as const)
      : ('unknown' as const),
    effortSelection: knownEfforts ? ('supported' as const) : ('unknown' as const),
    efforts: [...documented.efforts],
    requirement: knownEfforts
      ? documented.efforts.includes('none')
        ? ('optional' as const)
        : ('required' as const)
      : ('unknown' as const)
  }
  return {
    ...shared,
    chat: shared.chat === 'unknown' ? 'supported' : shared.chat,
    tools: shared.tools === 'unknown' ? 'supported' : shared.tools,
    stream: shared.stream === 'unknown' ? documented.streaming : shared.stream,
    reasoning: {
      support:
        shared.reasoning.support === 'unknown' ? reasoning.support : shared.reasoning.support,
      disable:
        shared.reasoning.disable === 'unknown' ? reasoning.disable : shared.reasoning.disable,
      effortSelection:
        shared.reasoning.effortSelection === 'unknown'
          ? reasoning.effortSelection
          : shared.reasoning.effortSelection,
      efforts:
        shared.reasoning.effortSelection === 'unknown'
          ? reasoning.efforts
          : shared.reasoning.efforts,
      requirement:
        shared.reasoning.requirement === 'unknown'
          ? reasoning.requirement
          : shared.reasoning.requirement
    },
    sources: shared.sources.length ? shared.sources : [retainedSource(shared.id)]
  }
}

function retainedSource(id: string): ModelCapabilities['sources'][number] {
  // Every positive alias/snapshot has its own independently reviewed official receipt.
  const verified = openAiChatEvidence[id]
  return {
    kind: 'official-model-documentation',
    url: verified.url,
    reviewedOn: '2026-10-05'
  }
}

export function modelCapabilities(
  provider: AiProvider,
  protocol: ApiProtocol,
  model: unknown
): ModelCapabilities {
  return immutableModelCapabilities(resolveModelCapabilities(provider, protocol, model))
}

/** Detach host enrichment/options as well as shared snapshots. */
export function immutableModelCapabilities(result: ModelCapabilities): ModelCapabilities {
  const reasoning = Object.freeze({
    ...result.reasoning,
    efforts: Object.freeze([...result.reasoning.efforts])
  })
  const sources = Object.freeze(result.sources.map((source) => Object.freeze({ ...source })))
  return Object.freeze({ ...result, reasoning, sources })
}

interface CatalogSnapshot {
  fingerprint: string
  generation: number
  models: Map<string, ModelCapabilities>
  at: number
}

/** Memory-only account-scoped metadata. No credentials or raw catalog are persisted. */
export class ModelCapabilityCatalog {
  private readonly snapshots = new Map<AiProvider, CatalogSnapshot>()
  private readonly maxAgeMs = 15 * 60_000

  constructor(private readonly now: () => number = Date.now) {}

  begin(provider: AiProvider, apiKey?: string): number {
    const fingerprint = this.fingerprint(apiKey)
    const previous = this.snapshots.get(provider)
    const generation = (previous?.generation ?? 0) + 1
    this.snapshots.set(provider, { fingerprint, generation, models: new Map(), at: 0 })
    return generation
  }

  invalidate(provider: AiProvider): void {
    const snapshot = this.snapshots.get(provider)
    if (!snapshot) return
    snapshot.generation++
    snapshot.models.clear()
    snapshot.at = 0
  }

  complete(
    provider: AiProvider,
    apiKey: string | undefined,
    generation: number,
    models: unknown[]
  ): boolean {
    const snapshot = this.snapshots.get(provider)
    if (
      !snapshot ||
      snapshot.generation !== generation ||
      snapshot.fingerprint !== this.fingerprint(apiKey)
    )
      return false
    const entries = new Map<string, ModelCapabilities>()
    for (const model of models) {
      try {
        const capabilities = normalizeModelCapabilities({
          apiVersion: 1,
          provider,
          protocol: 'chat-completions',
          model
        })
        // Retain only capability metadata, never unknown catalog properties/credentials.
        if (!apiKey || !capabilities.id.includes(apiKey)) entries.set(capabilities.id, capabilities)
      } catch {
        /* Invalid entries are not selectable. */
      }
    }
    snapshot.models = entries
    snapshot.at = this.now()
    return true
  }

  get(
    provider: AiProvider,
    apiKey: string | undefined,
    protocol: ApiProtocol,
    id: string
  ): ModelCapabilities {
    return this.selectedSnapshot(provider, apiKey, protocol, id).capabilities
  }

  selectedSnapshot(
    provider: AiProvider,
    apiKey: string | undefined,
    protocol: ApiProtocol,
    id: string
  ): SelectedModelCapabilitySnapshot {
    if (provider === 'openai')
      return { capabilities: modelCapabilities(provider, protocol, { id }) }
    const snapshot = this.snapshots.get(provider)
    if (
      snapshot?.fingerprint === this.fingerprint(apiKey) &&
      this.now() - snapshot.at < this.maxAgeMs
    ) {
      const capabilities = snapshot.models.get(id)
      if (capabilities?.protocol === protocol)
        return {
          capabilities,
          expiresAt: snapshot.at + this.maxAgeMs
        }
    }
    return { capabilities: modelCapabilities(provider, protocol, { id }) }
  }

  private fingerprint(apiKey?: string): string {
    return createHash('sha256')
      .update(apiKey ?? '')
      .digest('hex')
  }
}

export const modelCapabilityCatalog = new ModelCapabilityCatalog()

// Host settings may change outside these two components. Invalidate pending
// completions too, so switching away and back cannot resurrect an old catalog.
onSettingsChanged((next, previous) => {
  if (next.aiProvider !== previous.aiProvider) {
    modelCapabilityCatalog.invalidate('openai')
    modelCapabilityCatalog.invalidate('openrouter')
  }
  if (next.openaiApiKey !== previous.openaiApiKey) modelCapabilityCatalog.invalidate('openai')
  if (next.openrouterApiKey !== previous.openrouterApiKey)
    modelCapabilityCatalog.invalidate('openrouter')
})
