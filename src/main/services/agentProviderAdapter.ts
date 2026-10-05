import type {
  HistoryMessage,
  ModelProvider,
  ProviderGenerateOptions,
  ProviderResult,
  ToolDefinition
} from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
import type { AgentSession } from '../../shared/agentTypes'
import type { AiRuntimeSettings } from './aiProviderService'
import { getAiProvider } from './aiProviderService'

type SessionModel = Pick<AgentSession, 'model' | 'reasoningEffort'>

// Existing desktop controls allow these efforts without storing model capability metadata.
// This is a host compatibility assertion, not discovered per-model capability support.
// Preserve existing selections; the remote provider remains authoritative on support.
const LEGACY_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
// Allow longer reasoning runs while bounding both transports; cancellation remains immediate.
const AGENT_REQUEST_TIMEOUT_MS = 10 * 60_000

/** The host owns settings, app policy and sessions; vivi owns protocol and native history. */
export function createAgentProvider(
  settings: AiRuntimeSettings,
  session: SessionModel,
  options: { stream?: boolean } = {}
): ModelProvider {
  const reasoning =
    session.reasoningEffort === 'none'
      ? ({ mode: 'default' } as const)
      : ({ mode: 'effort', effort: session.reasoningEffort } as const)
  const common = {
    model: session.model,
    reasoning,
    supportedReasoningEfforts: LEGACY_REASONING_EFFORTS,
    stream: options.stream ?? false,
    timeoutMs: AGENT_REQUEST_TIMEOUT_MS
  }
  if (getAiProvider(settings) === 'openrouter') {
    if (!settings.openrouterApiKey?.trim()) {
      throw new Error('OpenRouter API key not configured. Please add it in Settings.')
    }
    return createOpenRouterProvider({
      ...common,
      apiKey: settings.openrouterApiKey,
      attribution: {
        referer: 'https://github.com/ayayaQ/bot-commander-desktop',
        title: 'Bot Commander for Discord'
      }
    })
  }
  if (!settings.openaiApiKey?.trim()) {
    throw new Error('OpenAI API key not configured. Please add it in Settings.')
  }
  return createOpenAIProvider({ ...common, apiKey: settings.openaiApiKey })
}

/** Convenience entry point for one non-streaming provider turn outside the full service. */
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
