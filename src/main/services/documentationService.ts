import documentationIndex from '../generated/documentationIndex.json'

export type DocumentationCategory = 'creating' | 'commands' | 'keywords' | 'tutorial' | 'webhooks'

interface DocumentationRecord {
  id: string
  title: string
  category: DocumentationCategory
  breadcrumbs: string[]
  content: string
  searchableText: string
  sourceUrl: string
}

const records = documentationIndex.records as DocumentationRecord[]
const MAX_BEST_CONTENT_CHARS = 2_000
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'does',
  'for',
  'how',
  'i',
  'in',
  'is',
  'of',
  'on',
  'or',
  'the',
  'to',
  'use',
  'using',
  'with'
])

interface DocumentationAlternative {
  id: string
  title: string
  category: DocumentationCategory
}

interface DocumentationBestMatch extends DocumentationAlternative {
  breadcrumbs: string[]
  content: string
  sourceUrl: string
  truncated: boolean
}

export interface DocumentationSearchResult {
  bestMatch: DocumentationBestMatch | null
  alternatives: DocumentationAlternative[]
  message?: string
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function queryTerms(query: string): string[] {
  const terms = query.split(/\s+/).filter(Boolean)
  const meaningful = terms.filter((term) => term.startsWith('$') || !STOP_WORDS.has(term))
  return [...new Set(meaningful.length ? meaningful : terms)]
}

function matchScore(record: DocumentationRecord, query: string): number {
  const title = normalize(record.title)
  const breadcrumbs = normalize(record.breadcrumbs.join(' '))
  const searchable = normalize(record.searchableText)
  const terms = queryTerms(query)
  const matchedTerms = terms.filter((term) => searchable.includes(term))
  if (!matchedTerms.length) return 0
  if (terms.length > 2 && matchedTerms.length === 1) return 0

  let score = Math.round((matchedTerms.length / terms.length) * 100)
  if (title === query) score += 1000
  else if (title.includes(query)) score += 600
  if (breadcrumbs.includes(query)) score += 300
  if (searchable.includes(query)) score += 150
  for (const term of matchedTerms) {
    if (title.includes(term)) score += 80
    if (breadcrumbs.includes(term)) score += 30
    if (searchable.includes(term)) score += 10
  }
  return score
}

export function searchDocumentation(
  rawQuery: string,
  category?: DocumentationCategory,
  rawLimit = 3
): DocumentationSearchResult {
  const query = normalize(rawQuery)
  if (!query) throw new Error('Documentation search query cannot be empty')
  const limit = Math.max(1, Math.min(Number(rawLimit) || 3, 5))

  const matches = records
    .map((record, order) => ({ record, order, score: matchScore(record, query) }))
    .filter((match) => match.score > 0 && (!category || match.record.category === category))
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, limit)
    .map(({ record }) => record)

  const [best, ...alternatives] = matches
  if (!best) {
    return {
      bestMatch: null,
      alternatives: [],
      message: 'No documentation matched. Try a shorter exact field, feature, or $keyword name.'
    }
  }

  return {
    bestMatch: {
      id: best.id,
      title: best.title,
      category: best.category,
      breadcrumbs: best.breadcrumbs,
      content: best.content.slice(0, MAX_BEST_CONTENT_CHARS),
      sourceUrl: best.sourceUrl,
      truncated: best.content.length > MAX_BEST_CONTENT_CHARS
    },
    alternatives: alternatives.map((record) => ({
      id: record.id,
      title: record.title,
      category: record.category
    }))
  }
}

export function readDocumentation(id: string): Omit<DocumentationRecord, 'searchableText'> {
  const record = records.find((item) => item.id === id)
  if (!record) throw new Error('Documentation section not found')
  const { searchableText: _, ...result } = record
  return result
}
