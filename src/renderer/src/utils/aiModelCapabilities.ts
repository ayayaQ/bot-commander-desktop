export interface AiModelCapabilityInfo {
  id: string
  supportsReasoning?: boolean
}

export type AiProvider = 'openai' | 'openrouter'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

const OPENAI_REASONING_MODEL_PATTERNS = [/^gpt-5(?:\.|-|$)/, /^o\d/]

export function openAiModelSupportsReasoning(modelId: string): boolean {
  return OPENAI_REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(modelId))
}

export function modelSupportsReasoning(
  provider: AiProvider,
  modelId: string,
  models: AiModelCapabilityInfo[]
): boolean {
  const model = models.find((item) => item.id === modelId)
  if (provider === 'openai') {
    return model?.supportsReasoning ?? openAiModelSupportsReasoning(modelId)
  }

  return model?.supportsReasoning === true
}

export function normalizeReasoningEffort(
  effort: ReasoningEffort,
  supportsReasoning: boolean
): ReasoningEffort {
  return supportsReasoning ? effort : 'none'
}
