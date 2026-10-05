// SPDX-License-Identifier: Apache-2.0
// Retained exact Responses coverage from the CLI's reviewed host registry:
// https://github.com/ayayaQ/vivi-cli/blob/01e6445d921773ecd3112d97d6327334abf931d3/src/models.ts
// These are Responses facts, never evidence for Chat Completions. Shared 0.4.0
// facts enrich/correct this registry rather than replacing its 52 IDs/72 exclusions.
import type { Capability, ReasoningEffort } from '@ayayaq/vivi/providers/models'

interface VerifiedModel {
  efforts: ReasoningEffort[]
  streaming: Capability
}
export const openaiCapabilities: Record<string, VerifiedModel> = Object.create(null) as Record<
  string,
  VerifiedModel
>
// Exact documented models whose task-specific endpoint cannot accept a text
// conversation through the CLI's Responses adapter. Unknown future IDs are not guessed.
// Sources: official /api/docs/models/{id} pages and their explicit Snapshots;
// /api/docs/guides/{embeddings,image-generation,speech-to-text,text-to-speech,
// audio-chat-completions,realtime,tools-web-search} and /api/docs/deprecations.
export const nonConversationOpenAI = new Set([
  'text-embedding-3-small',
  'text-embedding-3-large',
  'text-embedding-ada-002',
  'gpt-image-1',
  'gpt-image-1-mini',
  'gpt-image-1.5',
  'gpt-image-1.5-2025-12-16',
  'gpt-image-2',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
  'chatgpt-image-latest',
  'dall-e-2',
  'dall-e-3',
  'whisper-1',
  'gpt-transcribe',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe-diarize',
  'gpt-4o-mini-transcribe-2025-03-20',
  'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-mini-tts',
  'gpt-4o-mini-tts-2025-03-20',
  'gpt-4o-mini-tts-2025-12-15',
  'tts-1',
  'tts-1-hd',
  'gpt-live-1',
  'gpt-live-transcribe',
  'gpt-realtime-whisper',
  'gpt-realtime-translate',
  'gpt-realtime',
  'gpt-realtime-mini',
  'gpt-realtime-1.5',
  'gpt-realtime-2',
  'gpt-realtime-2.1',
  'gpt-realtime-2.1-mini',
  'gpt-realtime-2025-08-28',
  'gpt-realtime-mini-2025-10-06',
  'gpt-realtime-mini-2025-12-15',
  'gpt-audio',
  'gpt-audio-mini',
  'gpt-audio-1.5',
  'gpt-audio-2025-08-28',
  'gpt-audio-mini-2025-10-06',
  'gpt-audio-mini-2025-12-15',
  'gpt-4o-audio-preview',
  'gpt-4o-audio-preview-2024-10-01',
  'gpt-4o-audio-preview-2024-12-17',
  'gpt-4o-audio-preview-2025-06-03',
  'gpt-4o-mini-audio-preview',
  'gpt-4o-mini-audio-preview-2024-12-17',
  'gpt-4o-realtime-preview',
  'gpt-4o-realtime-preview-2024-10-01',
  'gpt-4o-realtime-preview-2024-12-17',
  'gpt-4o-realtime-preview-2025-06-03',
  'gpt-4o-mini-realtime-preview',
  'gpt-4o-mini-realtime-preview-2024-12-17',
  'omni-moderation-latest',
  'omni-moderation-2024-09-26',
  'text-moderation-latest',
  'text-moderation-stable',
  'text-moderation-007',
  'sora-2',
  'sora-2-pro',
  'babbage-002',
  'davinci-002',
  'gpt-3.5-turbo-instruct',
  'gpt-4o-search-preview',
  'gpt-4o-search-preview-2025-03-11',
  'gpt-4o-mini-search-preview',
  'gpt-4o-mini-search-preview-2025-03-11',
  'gpt-5-search-api',
  'chatgpt-4o-latest'
])
function documented(
  ids: string[],
  supported: ReasoningEffort[],
  streaming: Capability = 'supported'
): void {
  for (const id of ids) openaiCapabilities[id] = { efforts: supported, streaming }
}
documented(['gpt-6-astra', 'gpt-6.1-sol'], ['low', 'medium', 'high', 'xhigh', 'max'])
documented(
  ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6'],
  ['none', 'low', 'medium', 'high', 'xhigh', 'max']
)
documented(
  [
    'gpt-5',
    'gpt-5-2025-08-07',
    'gpt-5-mini',
    'gpt-5-mini-2025-08-07',
    'gpt-5-nano',
    'gpt-5-nano-2025-08-07'
  ],
  ['minimal', 'low', 'medium', 'high']
)
documented(['gpt-5-pro', 'gpt-5-pro-2025-10-06'], ['high'])
documented(['gpt-5.1', 'gpt-5.1-2025-11-13'], ['none', 'low', 'medium', 'high'])
documented(
  [
    'gpt-5.2',
    'gpt-5.2-2025-12-11',
    'gpt-5.4',
    'gpt-5.4-2026-03-05',
    'gpt-5.4-mini',
    'gpt-5.4-mini-2026-03-17',
    'gpt-5.5',
    'gpt-5.5-2026-04-23'
  ],
  ['none', 'low', 'medium', 'high', 'xhigh']
)
documented(
  ['gpt-5.2-pro', 'gpt-5.2-pro-2025-12-11', 'gpt-5.4-pro', 'gpt-5.4-pro-2026-03-05'],
  ['medium', 'high', 'xhigh']
)
documented(['gpt-5.5-pro', 'gpt-5.5-pro-2026-04-23'], ['medium', 'high', 'xhigh'], 'unsupported')
documented(
  ['o3', 'o3-2025-04-16', 'o3-mini', 'o3-mini-2025-01-31', 'o4-mini', 'o4-mini-2025-04-16'],
  ['low', 'medium', 'high']
)
documented(['o3-pro', 'o3-pro-2025-06-10'], [], 'unsupported')
documented(
  [
    'gpt-4.1',
    'gpt-4.1-2025-04-14',
    'gpt-4.1-mini',
    'gpt-4.1-mini-2025-04-14',
    'gpt-4.1-nano',
    'gpt-4.1-nano-2025-04-14',
    'gpt-4o',
    'gpt-4o-2024-05-13',
    'gpt-4o-2024-08-06',
    'gpt-4o-2024-11-20',
    'gpt-4o-mini',
    'gpt-4o-mini-2024-07-18'
  ],
  []
)

for (const entry of Object.values(openaiCapabilities)) {
  Object.freeze(entry.efforts)
  Object.freeze(entry)
}
Object.freeze(openaiCapabilities)
