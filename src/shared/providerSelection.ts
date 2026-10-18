import type { AiProvider } from './aiModelTypes'

export type ReviewerProvider = 'openai' | 'openrouter'
interface ProviderSettings {
  aiProvider?: AiProvider
  agentReviewerProvider?: ReviewerProvider
  openaiApiKey?: string
  openrouterApiKey?: string
  deepseekApiKey?: string
}

export function selectedProviderKey(settings: ProviderSettings): string {
  switch (settings.aiProvider) {
    case 'deepseek':
      return settings.deepseekApiKey || ''
    case 'openrouter':
      return settings.openrouterApiKey || ''
    default:
      return settings.openaiApiKey || ''
  }
}

/** Legacy sessions retain supported reviewer behavior. DeepSeek has no decision backend. */
export function selectedReviewer(settings: ProviderSettings): ReviewerProvider | undefined {
  if (
    settings.agentReviewerProvider === 'openai' ||
    settings.agentReviewerProvider === 'openrouter'
  )
    return settings.agentReviewerProvider
  if (settings.aiProvider === 'deepseek') return undefined
  return settings.aiProvider === 'openrouter' ? 'openrouter' : 'openai'
}
