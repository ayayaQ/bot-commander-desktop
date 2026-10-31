import type {
  HistoryMessage,
  ContextLimits,
  ModelProvider,
  ProviderGenerateOptions,
  ProviderResult,
  ToolDefinition
} from '@ayayaq/vivi'
import { createDeepSeekProvider } from '@ayayaq/vivi/providers/deepseek'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider, ProviderRequestError } from '@ayayaq/vivi/providers/openrouter'
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
import { createOpenRouterReasoningReplay } from './agentProviderHistory'
import { readOpenRouterDiagnostic } from './agentProviderError'

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
      `${provider === 'deepseek' ? 'DeepSeek' : provider === 'openai' ? 'OpenAI' : 'OpenRouter'} API key not configured. Please add it in Settings.`
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
    provider === 'deepseek'
      ? createDeepSeekProvider({ ...common, apiKey, ...(fetch ? { fetch } : {}) })
      : provider === 'openrouter'
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
  const reasoningReplay =
    provider === 'openrouter' ? createOpenRouterReasoningReplay(session.model) : undefined
  const projectInput = (input: {
    messages: readonly HistoryMessage[]
    tools: readonly ToolDefinition[]
  }) => {
    const supported = { ...input, tools: capabilities.tools === 'supported' ? input.tools : [] }
    return reasoningReplay?.project(supported) ?? supported
  }
  return {
    ...(transport.estimateContext
      ? {
          estimateContext: (input, estimateOptions) =>
            transport.estimateContext!(projectInput(input), estimateOptions)
        }
      : {}),
    generate: async (input, signal, generateOptions) => {
      let diagnostic: string | undefined
      const selected =
        provider === 'openrouter' ||
        (generateOptions?.purpose === 'context-summary' && options.onSummaryDispatch)
          ? createTransport(async (request, init) => {
              // Body validation and cancellation preflight have finished. Notify synchronously
              // immediately before the actual fetch invocation; estimates never reach it.
              signal.throwIfAborted()
              if (generateOptions?.purpose === 'context-summary') options.onSummaryDispatch?.()
              const response = await fetchImpl(request, init)
              if (provider === 'openrouter' && !response.ok) {
                diagnostic = await readOpenRouterDiagnostic(
                  response,
                  [
                    apiKey,
                    settings.openaiApiKey,
                    settings.deepseekApiKey ?? '',
                    settings.deepseekWebApiKey ?? ''
                  ],
                  init?.signal
                )
              }
              return response
            })
          : transport
      const projected = projectInput(input)
      try {
        const result = await selected.generate(projected, signal, generateOptions)
        reasoningReplay?.accept(projected, result)
        return result
      } catch (error) {
        if (diagnostic && error instanceof ProviderRequestError && error.code === 'http') {
          throw new ProviderRequestError(
            error.provider,
            error.code,
            `${error.message}: ${diagnostic}`,
            error.status
          )
        }
        throw error
      }
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
