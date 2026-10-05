// Endpoint-specific facts reviewed against exact official model pages on 2026-10-05.
// Separate from the retained Responses registry. Conditional GPT-6 Chat tool
// support stays unknown because Desktop provider-default omits reasoning effort.
import type { Capability, ModelCapabilities, ReasoningEffort } from '@ayayaq/vivi/providers/models'

type EndpointFacts = Pick<ModelCapabilities, 'chat' | 'tools' | 'stream' | 'reasoning'> & {
  url: string
}
export const openAiChatEvidence: Record<string, EndpointFacts> = Object.create(null)

function documented(
  ids: string[],
  url: string,
  chat: Capability,
  tools: Capability,
  stream: Capability,
  support: Capability,
  efforts?: ReasoningEffort[]
): void {
  const reasoning: ModelCapabilities['reasoning'] = efforts
    ? {
        support,
        disable: efforts.includes('none') ? 'supported' : 'unsupported',
        effortSelection: 'supported',
        efforts,
        requirement: efforts.includes('none') ? 'optional' : 'required'
      }
    : {
        support,
        disable: support === 'unsupported' ? 'unsupported' : 'unknown',
        effortSelection: support === 'unsupported' ? 'unsupported' : 'unknown',
        efforts: [],
        requirement: support === 'unsupported' ? 'optional' : 'unknown'
      }
  for (const id of ids) openAiChatEvidence[id] = { chat, tools, stream, reasoning, url }
}

documented(
  ['gpt-6-astra'],
  'https://developers.openai.com/api/docs/models/gpt-6-astra',
  'supported',
  'supported',
  'supported',
  'supported',
  ['low', 'medium', 'high', 'xhigh', 'max']
)
documented(
  ['gpt-6.1-sol'],
  'https://developers.openai.com/api/docs/models/gpt-6.1-sol',
  'supported',
  'unsupported',
  'supported',
  'supported',
  ['low', 'medium', 'high', 'xhigh', 'max']
)
documented(
  ['gpt-6-sol'],
  'https://developers.openai.com/api/docs/models/gpt-6-sol',
  'supported',
  'unknown',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh', 'max']
)
documented(
  ['gpt-6-luna'],
  'https://developers.openai.com/api/docs/models/gpt-6-luna',
  'supported',
  'unknown',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh', 'max']
)
documented(
  ['gpt-5.6-sol'],
  'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
  'supported',
  'supported',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh', 'max']
)
documented(
  ['gpt-5.6-terra'],
  'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
  'supported',
  'supported',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh', 'max']
)
documented(
  ['gpt-5.6-luna'],
  'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
  'supported',
  'supported',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh', 'max']
)
documented(
  ['gpt-5.6'],
  'https://developers.openai.com/api/docs/models/gpt-5.6',
  'supported',
  'supported',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh', 'max']
)
documented(
  ['gpt-5', 'gpt-5-2025-08-07'],
  'https://developers.openai.com/api/docs/models/gpt-5',
  'supported',
  'supported',
  'supported',
  'supported',
  ['minimal', 'low', 'medium', 'high']
)
documented(
  ['gpt-5-mini', 'gpt-5-mini-2025-08-07'],
  'https://developers.openai.com/api/docs/models/gpt-5-mini',
  'supported',
  'supported',
  'supported',
  'supported'
)
documented(
  ['gpt-5-nano', 'gpt-5-nano-2025-08-07'],
  'https://developers.openai.com/api/docs/models/gpt-5-nano',
  'supported',
  'supported',
  'supported',
  'supported'
)
documented(
  ['gpt-5-pro', 'gpt-5-pro-2025-10-06'],
  'https://developers.openai.com/api/docs/models/gpt-5-pro',
  'unsupported',
  'unsupported',
  'unsupported',
  'unsupported'
)
documented(
  ['gpt-5.1', 'gpt-5.1-2025-11-13'],
  'https://developers.openai.com/api/docs/models/gpt-5.1',
  'supported',
  'supported',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high']
)
documented(
  ['gpt-5.2', 'gpt-5.2-2025-12-11'],
  'https://developers.openai.com/api/docs/models/gpt-5.2',
  'supported',
  'supported',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh']
)
documented(
  ['gpt-5.4', 'gpt-5.4-2026-03-05'],
  'https://developers.openai.com/api/docs/models/gpt-5.4',
  'supported',
  'supported',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh']
)
documented(
  ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17'],
  'https://developers.openai.com/api/docs/models/gpt-5.4-mini',
  'supported',
  'supported',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh']
)
documented(
  ['gpt-5.5', 'gpt-5.5-2026-04-23'],
  'https://developers.openai.com/api/docs/models/gpt-5.5',
  'supported',
  'supported',
  'supported',
  'supported',
  ['none', 'low', 'medium', 'high', 'xhigh']
)
documented(
  ['gpt-5.2-pro', 'gpt-5.2-pro-2025-12-11'],
  'https://developers.openai.com/api/docs/models/gpt-5.2-pro',
  'unsupported',
  'unsupported',
  'unsupported',
  'unsupported'
)
documented(
  ['gpt-5.4-pro', 'gpt-5.4-pro-2026-03-05'],
  'https://developers.openai.com/api/docs/models/gpt-5.4-pro',
  'unsupported',
  'unsupported',
  'unsupported',
  'unsupported'
)
documented(
  ['gpt-5.5-pro', 'gpt-5.5-pro-2026-04-23'],
  'https://developers.openai.com/api/docs/models/gpt-5.5-pro',
  'unsupported',
  'unsupported',
  'unsupported',
  'unsupported'
)
documented(
  ['o3', 'o3-2025-04-16'],
  'https://developers.openai.com/api/docs/models/o3',
  'supported',
  'supported',
  'supported',
  'supported'
)
documented(
  ['o3-mini', 'o3-mini-2025-01-31'],
  'https://developers.openai.com/api/docs/models/o3-mini',
  'supported',
  'supported',
  'supported',
  'supported'
)
documented(
  ['o4-mini', 'o4-mini-2025-04-16'],
  'https://developers.openai.com/api/docs/models/o4-mini',
  'supported',
  'supported',
  'supported',
  'supported'
)
documented(
  ['o3-pro', 'o3-pro-2025-06-10'],
  'https://developers.openai.com/api/docs/models/o3-pro',
  'unsupported',
  'unsupported',
  'unsupported',
  'unsupported'
)
documented(
  ['gpt-4.1', 'gpt-4.1-2025-04-14'],
  'https://developers.openai.com/api/docs/models/gpt-4.1',
  'supported',
  'supported',
  'supported',
  'unsupported'
)
documented(
  ['gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14'],
  'https://developers.openai.com/api/docs/models/gpt-4.1-mini',
  'supported',
  'supported',
  'supported',
  'unsupported'
)
documented(
  ['gpt-4.1-nano', 'gpt-4.1-nano-2025-04-14'],
  'https://developers.openai.com/api/docs/models/gpt-4.1-nano',
  'supported',
  'supported',
  'supported',
  'unsupported'
)
documented(
  ['gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'],
  'https://developers.openai.com/api/docs/models/gpt-4o',
  'supported',
  'supported',
  'supported',
  'unknown'
)
documented(
  ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'],
  'https://developers.openai.com/api/docs/models/gpt-4o-mini',
  'supported',
  'supported',
  'supported',
  'unknown'
)

for (const entry of Object.values(openAiChatEvidence)) {
  Object.freeze(entry.reasoning.efforts)
  Object.freeze(entry.reasoning)
  Object.freeze(entry)
}
Object.freeze(openAiChatEvidence)
