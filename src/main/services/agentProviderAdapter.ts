import type {
  HistoryMessage,
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

/** The host owns account metadata/policy; vivi owns protocol and native history. */
export function createAgentProvider(
  settings: AiRuntimeSettings,
  session: SessionModel,
  options: { stream?: boolean; capabilities?: ModelCapabilities } = {}
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
  const transport =
    provider === 'openrouter'
      ? createOpenRouterProvider({
          ...common,
          apiKey,
          attribution: {
            referer: 'https://github.com/ayayaQ/bot-commander-desktop',
            title: 'Bot Commander for Discord'
          }
        })
      : createOpenAIProvider({ ...common, apiKey })
  return {
    generate: (input, signal, generateOptions) =>
      transport.generate(
        {
          ...input,
          tools: capabilities.tools === 'supported' ? input.tools : []
        },
        signal,
        generateOptions
      )
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
