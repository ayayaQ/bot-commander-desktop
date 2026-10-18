import type {
  HistoryMessage,
  ContextLimits,
  ModelProvider,
  ProviderGenerateOptions,
  ProviderResult,
  ToolDefinition
} from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
import type { ModelCapabilities } from '@ayayaq/vivi/providers/models'
import type { AgentSession } from '../../shared/agentTypes'
import { agentProtocol } from '../../shared/aiModelTypes'
import {
  providerReasoningEfforts,
  reasoningConfigurationError,
  reasoningSelection
} from '../../shared/modelReasoningControls'
import type { AiRuntimeSettings } from './aiProviderService'
import { getAiProvider, getProviderApiKey } from './aiProviderService'
import { immutableModelCapabilities, modelCapabilityCatalog } from './modelCapabilityService'

type SessionModel = Pick<AgentSession, 'model' | 'reasoningEffort'>
const AGENT_REQUEST_TIMEOUT_MS = 10 * 60_000

export function getAgentModelCapabilities(
  settings: AiRuntimeSettings,
  id: string
): ModelCapabilities {
  const provider = getAiProvider(settings)
  return modelCapabilityCatalog.get(
    provider,
    getProviderApiKey(settings),
    agentProtocol(provider),
    id
  )
}

export function getAgentContextLimits(settings: AiRuntimeSettings, id: string): ContextLimits {
  const provider = getAiProvider(settings)
  const snapshot = modelCapabilityCatalog.selectedSnapshot(
    provider,
    getProviderApiKey(settings),
    agentProtocol(provider),
    id
  )
  const capabilities = snapshot.capabilities
  const source = capabilities.contextLimitsSource
  return {
    contextWindow: capabilities.contextWindow,
    maxInputTokens: capabilities.maxInputTokens,
    maxOutputTokens: capabilities.maxOutputTokens,
    ...(source
      ? {
          source: {
            ...source,
            ...(snapshot.fetchedAt !== undefined
              ? {
                  fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
                  freshness: 'cached' as const
                }
              : {})
          }
        }
      : {})
  }
}

/** The host owns account metadata/policy; vivi owns protocol and native history. */
export function createAgentProvider(
  settings: AiRuntimeSettings,
  session: SessionModel,
  options: {
    stream?: boolean
    capabilities?: ModelCapabilities
    onSummaryDispatch?: () => void
  } = {}
): ModelProvider {
  const provider = getAiProvider(settings)
  const apiKey = getProviderApiKey(settings)
  if (!apiKey.trim()) {
    throw new Error(
      `${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} API key not configured. Please add it in Settings.`
    )
  }
  const capabilities = immutableModelCapabilities(
    options.capabilities ?? getAgentModelCapabilities(settings, session.model)
  )
  if (
    capabilities.provider !== provider ||
    capabilities.protocol !== agentProtocol(provider) ||
    capabilities.id !== session.model
  )
    throw new Error('Model capability snapshot does not match the selected provider and API')
  if (capabilities.chat === 'unsupported') {
    throw new Error(
      'This model does not support text conversation through the agent API. Choose another model.'
    )
  }
  const error = reasoningConfigurationError(capabilities, session.reasoningEffort)
  if (error) throw new Error(error)
  const common = {
    model: session.model,
    reasoning: reasoningSelection(session.reasoningEffort),
    supportedReasoningEfforts: providerReasoningEfforts(capabilities),
    stream: capabilities.stream === 'unsupported' ? false : (options.stream ?? false),
    timeoutMs: AGENT_REQUEST_TIMEOUT_MS
  }
  const createTransport = (fetch?: typeof globalThis.fetch) =>
    provider === 'openrouter'
      ? createOpenRouterProvider({
          ...common,
          ...(fetch ? { fetch } : {}),
          apiKey,
          attribution: {
            referer: 'https://github.com/ayayaQ/bot-commander-desktop',
            title: 'Bot Commander for Discord'
          }
        })
      : createOpenAIProvider({ ...common, apiKey, ...(fetch ? { fetch } : {}) })
  const transport = createTransport()
  const fetchImpl = globalThis.fetch
  return {
    ...(transport.estimateContext
      ? {
          estimateContext: (input, estimateOptions) =>
            transport.estimateContext!(
              { ...input, tools: capabilities.tools === 'supported' ? input.tools : [] },
              estimateOptions
            )
        }
      : {}),
    generate: (input, signal, generateOptions) => {
      const selected =
        generateOptions?.purpose === 'context-summary' && options.onSummaryDispatch
          ? createTransport((request, init) => {
              // Body validation and cancellation preflight have finished. This callback is sync,
              // immediately before the actual fetch invocation; estimates never reach it.
              signal.throwIfAborted()
              options.onSummaryDispatch!()
              return fetchImpl(request, init)
            })
          : transport
      return selected.generate(
        {
          ...input,
          tools: capabilities.tools === 'supported' ? input.tools : []
        },
        signal,
        generateOptions
      )
    }
  }
}

export async function executeAgentProviderTurn(
  settings: AiRuntimeSettings,
  session: SessionModel,
  messages: readonly HistoryMessage[],
  tools: readonly ToolDefinition[],
  signal: AbortSignal,
  options?: ProviderGenerateOptions
): Promise<ProviderResult> {
  return createAgentProvider(settings, session).generate({ messages, tools }, signal, options)
}
