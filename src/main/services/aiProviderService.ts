import OpenAI from 'openai'
import type { AppSettings } from '../types/types'

export type AiProvider = 'openai' | 'openrouter'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
export type AiRuntimeSettings = Partial<AppSettings> & {
  openaiApiKey: string
  openaiModel?: string
  openrouterApiKey?: string
  selectedAiModel?: string
  selectedOpenAiModel?: string
  selectedOpenRouterModel?: string
  aiProvider?: AiProvider
}

export interface AiModelInfo {
  id: string
  name: string
  description?: string
  contextLength?: number
  supportsStructuredOutputs?: boolean
  pricing?: {
    prompt?: string
    completion?: string
    request?: string
    image?: string
    webSearch?: string
    internalReasoning?: string
    inputCacheRead?: string
    inputCacheWrite?: string
  }
}

export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id: string
    name?: string
    description?: string
    context_length?: number
    supported_parameters?: string[]
    pricing?: {
      prompt?: string
      completion?: string
      request?: string
      image?: string
      web_search?: string
      internal_reasoning?: string
      input_cache_read?: string
      input_cache_write?: string
    }
    architecture?: {
      output_modalities?: string[]
    }
  }>
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const APP_REFERER = 'https://github.com/ayayaQ/bot-commander-desktop'
const APP_TITLE = 'Bot Commander for Discord'

export function getAiProvider(settings: AiRuntimeSettings): AiProvider {
  return settings.aiProvider === 'openrouter' ? 'openrouter' : 'openai'
}

export function getSelectedAiModel(settings: AiRuntimeSettings): string {
  if (getAiProvider(settings) === 'openrouter') {
    return settings.selectedOpenRouterModel || settings.selectedAiModel || 'openai/gpt-5.2'
  }
  if (settings.selectedOpenAiModel) return settings.selectedOpenAiModel
  return settings.selectedAiModel || settings.openaiModel || 'gpt-4.1-nano'
}

export function getProviderApiKey(settings: AiRuntimeSettings): string {
  return getAiProvider(settings) === 'openrouter'
    ? settings.openrouterApiKey || ''
    : settings.openaiApiKey || ''
}

export function validateAiConfiguration(settings: AiRuntimeSettings): string | null {
  const provider = getAiProvider(settings)
  if (provider === 'openrouter') {
    if (!settings.openrouterApiKey)
      return 'OpenRouter API key not configured. Please add it in Settings.'
    if (!settings.openaiApiKey) {
      return 'OpenAI API key is required to moderate OpenRouter responses. Please add it in Settings.'
    }
    return null
  }

  if (!settings.openaiApiKey) return 'OpenAI API key not configured. Please add it in Settings.'
  return null
}

export async function fetchAiModels(provider: AiProvider, apiKey?: string): Promise<AiModelInfo[]> {
  if (provider === 'openrouter') {
    const response = await fetch(`${OPENROUTER_BASE_URL}/models?output_modalities=text`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
    })
    if (!response.ok) {
      throw new Error(`OpenRouter models request failed (${response.status})`)
    }
    const json = (await response.json()) as OpenRouterModelsResponse
    return (json.data || []).map((model) => ({
      id: model.id,
      name: model.name || model.id,
      description: model.description,
      contextLength: model.context_length,
      supportsStructuredOutputs:
        model.supported_parameters?.includes('response_format') ||
        model.supported_parameters?.includes('structured_outputs'),
      pricing: model.pricing
        ? {
            prompt: model.pricing.prompt,
            completion: model.pricing.completion,
            request: model.pricing.request,
            image: model.pricing.image,
            webSearch: model.pricing.web_search,
            internalReasoning: model.pricing.internal_reasoning,
            inputCacheRead: model.pricing.input_cache_read,
            inputCacheWrite: model.pricing.input_cache_write
          }
        : undefined
    }))
  }

  if (!apiKey) {
    throw new Error('OpenAI API key is required to fetch OpenAI models')
  }

  const openai = new OpenAI({ apiKey })
  const page = await openai.models.list()
  const ids = page.data
    .map((model) => model.id)
    .filter((id) => /^(gpt-|o[0-9]|chatgpt-)/.test(id))
    .sort()

  return ids.map((id) => ({ id, name: id }))
}

export async function moderateTextWithOpenAI(
  settings: AiRuntimeSettings,
  text: string
): Promise<boolean> {
  if (!text.trim()) return false
  if (!settings.openaiApiKey) throw new Error('OpenAI API key is required for moderation')

  const openai = new OpenAI({ apiKey: settings.openaiApiKey })
  const moderation = await openai.moderations.create({
    input: text,
    model: 'omni-moderation-latest'
  })
  return moderation.results.some((result) => result.flagged)
}

export async function createAiChatCompletion(
  settings: AiRuntimeSettings,
  messages: AiChatMessage[],
  model = getSelectedAiModel(settings),
  options: {
    responseFormat?: unknown
    requireStructuredOutputs?: boolean
    reasoningEffort?: ReasoningEffort
  } = {}
): Promise<{ content: string; tokenCount: number }> {
  const configError = validateAiConfiguration(settings)
  if (configError) throw new Error(configError)

  if (getAiProvider(settings) === 'openrouter') {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': APP_REFERER,
        'X-OpenRouter-Title': APP_TITLE,
        'X-Title': APP_TITLE
      },
      body: JSON.stringify({
        model,
        messages,
        ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        ...(options.reasoningEffort && options.reasoningEffort !== 'none'
          ? { reasoning: { effort: options.reasoningEffort, exclude: true } }
          : {}),
        ...(options.requireStructuredOutputs ? { provider: { require_parameters: true } } : {})
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`OpenRouter API error (${response.status}): ${errorText}`)
    }

    const json = await response.json()
    return {
      content: json.choices?.[0]?.message?.content ?? '',
      tokenCount: json.usage?.total_tokens || 0
    }
  }

  const openai = new OpenAI({ apiKey: settings.openaiApiKey })
  const completion = await openai.chat.completions.create({
    model,
    messages,
    ...(options.reasoningEffort && options.reasoningEffort !== 'none'
      ? { reasoning_effort: options.reasoningEffort }
      : {})
  } as any)

  return {
    content: completion.choices[0].message.content ?? '',
    tokenCount: completion.usage?.total_tokens || 0
  }
}
