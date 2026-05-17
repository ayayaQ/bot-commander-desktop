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
  supportedParameters?: string[]
  outputModalities?: string[]
  supportsStructuredOutputs?: boolean
  supportsReasoning?: boolean
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
  data?: OpenRouterModel[]
}

interface OpenRouterModel {
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
}

interface OpenRouterErrorResponse {
  error?: {
    code?: number | string
    message?: string
    metadata?: Record<string, unknown>
  }
  message?: string
}

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const APP_REFERER = 'https://github.com/ayayaQ/bot-commander-desktop'
const APP_TITLE = 'Bot Commander for Discord'
const OPENAI_TEXT_MODEL_PREFIXES = [/^gpt-/, /^o\d/, /^chatgpt-/]
const OPENAI_NON_TEXT_MODEL_PATTERNS = [
  /^o\d/,
  /(^|[-/])audio($|[-/])/,
  /(^|[-/])realtime($|[-/])/,
  /(^|[-/])search($|[-/])/,
  /(^|[-/])pro($|[-/])/,
  /(^|[-/])transcribe($|[-/])/,
  /(^|[-/])tts($|[-/])/,
  /(^|[-/])image($|[-/])/,
  /^gpt-image/,
  /^dall-e/,
  /^tts-/,
  /^whisper-/
]
const OPENAI_REASONING_MODEL_PREFIXES = [/^gpt-5(?:\.|-|$)/, /^o\d/]

function includesOpenRouterParameter(model: OpenRouterModel, parameter: string): boolean {
  return model.supported_parameters?.includes(parameter) === true
}

function hasTextOutput(model: OpenRouterModel): boolean {
  const outputModalities = model.architecture?.output_modalities
  return !outputModalities || outputModalities.length === 0 || outputModalities.includes('text')
}

function toAiModelInfo(model: OpenRouterModel): AiModelInfo {
  const supportsStructuredOutputs =
    includesOpenRouterParameter(model, 'response_format') ||
    includesOpenRouterParameter(model, 'structured_outputs')

  return {
    id: model.id,
    name: model.name || model.id,
    description: model.description,
    contextLength: model.context_length,
    supportedParameters: model.supported_parameters || [],
    outputModalities: model.architecture?.output_modalities || [],
    supportsStructuredOutputs,
    supportsReasoning:
      includesOpenRouterParameter(model, 'reasoning') ||
      includesOpenRouterParameter(model, 'include_reasoning'),
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
  }
}

function isOpenAiTextGenerationModel(id: string): boolean {
  return (
    OPENAI_TEXT_MODEL_PREFIXES.some((pattern) => pattern.test(id)) &&
    !OPENAI_NON_TEXT_MODEL_PATTERNS.some((pattern) => pattern.test(id))
  )
}

function openAiModelSupportsReasoning(id: string): boolean {
  return OPENAI_REASONING_MODEL_PREFIXES.some((pattern) => pattern.test(id))
}

function toOpenAiModelInfo(id: string): AiModelInfo {
  const supportsReasoning = openAiModelSupportsReasoning(id)
  return {
    id,
    name: id,
    outputModalities: ['text'],
    supportsReasoning,
    supportsStructuredOutputs: true,
    supportedParameters: supportsReasoning
      ? ['reasoning_effort', 'response_format']
      : ['response_format']
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatOpenRouterMetadata(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return []
  const details: string[] = []
  const providerName = metadata.provider_name
  const modelSlug = metadata.model_slug
  const reasons = metadata.reasons
  const flaggedInput = metadata.flagged_input
  const raw = metadata.raw

  if (typeof providerName === 'string' && providerName) details.push(`Provider: ${providerName}`)
  if (typeof modelSlug === 'string' && modelSlug) details.push(`Model: ${modelSlug}`)
  if (Array.isArray(reasons) && reasons.length > 0) {
    details.push(`Reasons: ${reasons.map(String).join(', ')}`)
  }
  if (typeof flaggedInput === 'string' && flaggedInput) {
    details.push(`Flagged input: ${flaggedInput}`)
  }
  if (raw !== undefined) {
    details.push(`Provider detail: ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`)
  }

  return details
}

function formatOpenRouterError(
  body: string,
  status?: number,
  retryAfter?: string | null,
  fallbackMessage = body
): string {
  try {
    const json = JSON.parse(body) as OpenRouterErrorResponse
    const error = json.error
    const message = error?.message || json.message || fallbackMessage
    const code = error?.code ?? status
    const details = [
      code ? `Code: ${code}` : null,
      retryAfter ? `Retry after: ${retryAfter}s` : null,
      ...formatOpenRouterMetadata(isRecord(error?.metadata) ? error.metadata : undefined)
    ].filter((detail): detail is string => Boolean(detail))

    return details.length > 0 ? `${message} (${details.join('; ')})` : message
  } catch {
    return fallbackMessage
  }
}

function formatOpenRouterChoiceError(choice: any): string | null {
  const error = choice?.error
  if (!error) return null
  const message = error.message || JSON.stringify(error)
  const details = [
    error.code ? `Code: ${error.code}` : null,
    ...formatOpenRouterMetadata(isRecord(error.metadata) ? error.metadata : undefined)
  ].filter((detail): detail is string => Boolean(detail))
  return details.length > 0 ? `${message} (${details.join('; ')})` : message
}

export function getAiProvider(settings: AiRuntimeSettings): AiProvider {
  return settings.aiProvider === 'openrouter' ? 'openrouter' : 'openai'
}

export function getSelectedAiModel(settings: AiRuntimeSettings): string {
  if (getAiProvider(settings) === 'openrouter') {
    return settings.selectedOpenRouterModel || settings.selectedAiModel || 'openai/gpt-5.4-nano'
  }
  if (settings.selectedOpenAiModel) return settings.selectedOpenAiModel
  return settings.selectedAiModel || settings.openaiModel || 'gpt-5.4-nano'
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
    const params = new URLSearchParams({ output_modalities: 'text' })
    const response = await fetch(`${OPENROUTER_BASE_URL}/models?${params.toString()}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined
    })
    if (!response.ok) {
      const errorText = formatOpenRouterError(
        await response.text(),
        response.status,
        response.headers.get('Retry-After')
      )
      throw new Error(`OpenRouter models request failed (${response.status}): ${errorText}`)
    }
    const json = (await response.json()) as OpenRouterModelsResponse
    return (json.data || [])
      .filter((model) => model.id && hasTextOutput(model))
      .map(toAiModelInfo)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  if (!apiKey) {
    throw new Error('OpenAI API key is required to fetch OpenAI models')
  }

  const openai = new OpenAI({ apiKey })
  const page = await openai.models.list()
  const ids = page.data
    .map((model) => model.id)
    .filter(isOpenAiTextGenerationModel)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))

  return ids.map(toOpenAiModelInfo)
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
      const errorText = formatOpenRouterError(
        await response.text(),
        response.status,
        response.headers.get('Retry-After')
      )
      throw new Error(`OpenRouter API error (${response.status}): ${errorText}`)
    }

    const json = await response.json()
    const choice = json.choices?.[0]
    const choiceError = formatOpenRouterChoiceError(choice)
    if (choiceError) {
      throw new Error(`OpenRouter API error: ${choiceError}`)
    }
    const content = choice?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(
        'OpenRouter response did not include text content. The provider may still be warming up; try again shortly or choose a different model.'
      )
    }
    return {
      content,
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
