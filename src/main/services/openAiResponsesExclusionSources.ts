// Precise official Responses exclusion receipts reviewed 2026-10-05.
// Preserves all 72 prior CLI text-conversation exclusions, independently of
// Desktop's Chat catalog policy. Exact alias/snapshot IDs are explicit.
import type { CapabilitySource } from '@ayayaq/vivi/providers/models'

export const openAiResponsesExclusionSources: Record<string, CapabilitySource> = Object.create(null)
function excluded(ids: string[], url: string): void {
  for (const id of ids)
    openAiResponsesExclusionSources[id] = Object.freeze({
      kind: 'official-model-documentation',
      url,
      reviewedOn: '2026-10-05'
    })
}

excluded(['babbage-002'], 'https://developers.openai.com/api/docs/models/babbage-002.md')
// Explicit prose says deprecated and removed from API.
excluded(
  ['chatgpt-4o-latest'],
  'https://developers.openai.com/api/docs/models/chatgpt-4o-latest.md'
)
excluded(
  ['chatgpt-image-latest'],
  'https://developers.openai.com/api/docs/models/chatgpt-image-latest.md'
)
excluded(['dall-e-2'], 'https://developers.openai.com/api/docs/models/dall-e-2.md')
excluded(['dall-e-3'], 'https://developers.openai.com/api/docs/models/dall-e-3.md')
excluded(['davinci-002'], 'https://developers.openai.com/api/docs/models/davinci-002.md')
// Explicit prose says only compatible with legacy Completions; generic endpoint table contradicts prose.
excluded(
  ['gpt-3.5-turbo-instruct'],
  'https://developers.openai.com/api/docs/models/gpt-3.5-turbo-instruct.md'
)
excluded(
  [
    'gpt-4o-audio-preview',
    'gpt-4o-audio-preview-2024-10-01',
    'gpt-4o-audio-preview-2024-12-17',
    'gpt-4o-audio-preview-2025-06-03'
  ],
  'https://developers.openai.com/api/docs/models/gpt-4o-audio-preview.md'
)
excluded(
  ['gpt-4o-mini-audio-preview', 'gpt-4o-mini-audio-preview-2024-12-17'],
  'https://developers.openai.com/api/docs/models/gpt-4o-mini-audio-preview.md'
)
excluded(
  ['gpt-4o-mini-realtime-preview', 'gpt-4o-mini-realtime-preview-2024-12-17'],
  'https://developers.openai.com/api/docs/models/gpt-4o-mini-realtime-preview.md'
)
excluded(
  ['gpt-4o-mini-search-preview', 'gpt-4o-mini-search-preview-2025-03-11'],
  'https://developers.openai.com/api/docs/models/gpt-4o-mini-search-preview.md'
)
excluded(
  [
    'gpt-4o-mini-transcribe',
    'gpt-4o-mini-transcribe-2025-03-20',
    'gpt-4o-mini-transcribe-2025-12-15'
  ],
  'https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe.md'
)
excluded(
  ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts-2025-12-15'],
  'https://developers.openai.com/api/docs/models/gpt-4o-mini-tts.md'
)
excluded(
  [
    'gpt-4o-realtime-preview',
    'gpt-4o-realtime-preview-2024-10-01',
    'gpt-4o-realtime-preview-2024-12-17',
    'gpt-4o-realtime-preview-2025-06-03'
  ],
  'https://developers.openai.com/api/docs/models/gpt-4o-realtime-preview.md'
)
excluded(
  ['gpt-4o-search-preview', 'gpt-4o-search-preview-2025-03-11'],
  'https://developers.openai.com/api/docs/models/gpt-4o-search-preview.md'
)
excluded(
  ['gpt-4o-transcribe'],
  'https://developers.openai.com/api/docs/models/gpt-4o-transcribe.md'
)
excluded(
  ['gpt-4o-transcribe-diarize'],
  'https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize.md'
)
// Guide places gpt-5-search-api in specialized Chat Completions search model path; new Responses search uses web_search with a conversation model instead.
excluded(['gpt-5-search-api'], 'https://developers.openai.com/api/docs/guides/tools-web-search.md')
excluded(
  ['gpt-audio', 'gpt-audio-2025-08-28'],
  'https://developers.openai.com/api/docs/models/gpt-audio.md'
)
excluded(['gpt-audio-1.5'], 'https://developers.openai.com/api/docs/models/gpt-audio-1.5.md')
excluded(
  ['gpt-audio-mini', 'gpt-audio-mini-2025-10-06', 'gpt-audio-mini-2025-12-15'],
  'https://developers.openai.com/api/docs/models/gpt-audio-mini.md'
)
// Image-only output, not text conversation.
excluded(['gpt-image-1'], 'https://developers.openai.com/api/docs/models/gpt-image-1.md')
excluded(['gpt-image-1-mini'], 'https://developers.openai.com/api/docs/models/gpt-image-1-mini.md')
excluded(
  ['gpt-image-1.5', 'gpt-image-1.5-2025-12-16'],
  'https://developers.openai.com/api/docs/models/gpt-image-1.5.md'
)
excluded(['gpt-image-2'], 'https://developers.openai.com/api/docs/models/gpt-image-2.md')
excluded(
  ['gpt-image-2.5-flare'],
  'https://developers.openai.com/api/docs/models/gpt-image-2.5-flare.md'
)
excluded(
  ['gpt-image-2.5-sunburst'],
  'https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst.md'
)
excluded(['gpt-live-1'], 'https://developers.openai.com/api/docs/models/gpt-live-1.md')
excluded(
  ['gpt-live-transcribe'],
  'https://developers.openai.com/api/docs/models/gpt-live-transcribe.md'
)
excluded(
  ['gpt-realtime', 'gpt-realtime-2025-08-28'],
  'https://developers.openai.com/api/docs/models/gpt-realtime.md'
)
excluded(['gpt-realtime-1.5'], 'https://developers.openai.com/api/docs/models/gpt-realtime-1.5.md')
excluded(['gpt-realtime-2'], 'https://developers.openai.com/api/docs/models/gpt-realtime-2.md')
excluded(['gpt-realtime-2.1'], 'https://developers.openai.com/api/docs/models/gpt-realtime-2.1.md')
excluded(
  ['gpt-realtime-2.1-mini'],
  'https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini.md'
)
excluded(
  ['gpt-realtime-mini', 'gpt-realtime-mini-2025-10-06', 'gpt-realtime-mini-2025-12-15'],
  'https://developers.openai.com/api/docs/models/gpt-realtime-mini.md'
)
excluded(
  ['gpt-realtime-translate'],
  'https://developers.openai.com/api/docs/models/gpt-realtime-translate.md'
)
excluded(
  ['gpt-realtime-whisper'],
  'https://developers.openai.com/api/docs/models/gpt-realtime-whisper.md'
)
excluded(['gpt-transcribe'], 'https://developers.openai.com/api/docs/models/gpt-transcribe.md')
excluded(
  ['omni-moderation-2024-09-26'],
  'https://developers.openai.com/api/docs/models/omni-moderation-latest.md'
)
excluded(
  ['omni-moderation-latest'],
  'https://developers.openai.com/api/docs/models/omni-moderation-latest.md'
)
excluded(['sora-2'], 'https://developers.openai.com/api/docs/models/sora-2.md')
excluded(['sora-2-pro'], 'https://developers.openai.com/api/docs/models/sora-2-pro.md')
excluded(
  ['text-embedding-3-large'],
  'https://developers.openai.com/api/docs/models/text-embedding-3-large.md'
)
excluded(
  ['text-embedding-3-small'],
  'https://developers.openai.com/api/docs/models/text-embedding-3-small.md'
)
excluded(
  ['text-embedding-ada-002'],
  'https://developers.openai.com/api/docs/models/text-embedding-ada-002.md'
)
excluded(
  ['text-moderation-007'],
  'https://developers.openai.com/api/docs/models/text-moderation-stable.md'
)
excluded(
  ['text-moderation-latest'],
  'https://developers.openai.com/api/docs/models/text-moderation-latest.md'
)
excluded(
  ['text-moderation-stable'],
  'https://developers.openai.com/api/docs/models/text-moderation-stable.md'
)
excluded(['tts-1'], 'https://developers.openai.com/api/docs/models/tts-1.md')
excluded(['tts-1-hd'], 'https://developers.openai.com/api/docs/models/tts-1-hd.md')
excluded(['whisper-1'], 'https://developers.openai.com/api/docs/models/whisper-1.md')
// The official guide scopes this specialized search model to Chat Completions.
excluded(['gpt-5-search-api'], 'https://developers.openai.com/api/docs/guides/tools-web-search.md')

Object.freeze(openAiResponsesExclusionSources)
