import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import documentationIndex from '../generated/documentationIndex.json'
import { readDocumentation, searchDocumentation } from './documentationService'

describe('documentation service', () => {
  it('ships a valid functional documentation index with stable unique IDs', () => {
    const records = documentationIndex.records
    const ids = records.map((record) => record.id)

    expect(documentationIndex.schemaVersion).toBe(2)
    expect(documentationIndex.language).toBe('en')
    expect(documentationIndex.sourceRevision).toMatch(/^[a-f0-9]{40}$/)
    expect(documentationIndex.sourceContentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(records.length).toBeGreaterThan(200)
    expect(new Set(ids).size).toBe(ids.length)
    expect(
      records.every(
        (record) =>
          record.content && record.sourceUrl.startsWith('https://ayayaq.com/DiscordBots-Help/')
      )
    ).toBe(true)
  })

  it('ships a deterministic compact table of contents in documentation order', () => {
    const root = new Map<string, Map<string, unknown>>()
    for (const record of documentationIndex.records) {
      const path = [record.category, ...record.breadcrumbs.slice(1), record.title]
      let current = root as Map<string, any>
      for (const part of path) {
        if (!current.has(part)) current.set(part, new Map())
        current = current.get(part)
      }
    }

    const lines: string[] = []
    function appendLines(nodes: Map<string, any>, depth: number) {
      for (const [title, children] of nodes) {
        lines.push(`${'\t'.repeat(depth)}${title}`)
        appendLines(children, depth + 1)
      }
    }
    appendLines(root, 0)

    expect(documentationIndex.tableOfContents).toBe(lines.join('\n'))
    expect(documentationIndex.tableOfContents).toContain(
      'creating\n\tCreating the bot\n\tInviting the bot'
    )
    expect(documentationIndex.tableOfContents).toContain(
      'keywords\n\tUser Info\n\t\t$name\n\t\t$avatar'
    )
    expect(documentationIndex.tableOfContents).toContain(
      'interactions\n\tOverview and Registration\n\t\tWhat interactions are'
    )
    expect(documentationIndex.tableOfContents).not.toContain('\tKeywords\n')
  })

  it('ranks exact keyword titles first and supports category filters', () => {
    const exact = searchDocumentation('$rollnum', undefined, 5)
    expect(exact.bestMatch).toMatchObject({
      id: 'keywords:keywords-misc-rollnum',
      title: '$rollnum(min,max)',
      category: 'keywords',
      truncated: false
    })
    expect(exact.bestMatch?.content).toContain('random number')

    const tutorialOnly = searchDocumentation('starts with', 'tutorial', 3)
    expect(tutorialOnly.bestMatch?.category).toBe('tutorial')
    expect(tutorialOnly.alternatives.every((record) => record.category === 'tutorial')).toBe(true)
  })

  it('covers every canonical interpreter keyword by exact spelling', () => {
    const interpreter = fs.readFileSync(
      new URL('./bcfdLang/interpreter.ts', import.meta.url),
      'utf8'
    )
    const registered = [...interpreter.matchAll(/registry\.set\(\s*['"]([^'"]+)/g)].map(
      (match) => match[1]
    )
    const keywordText = documentationIndex.records
      .filter((record) => record.category === 'keywords')
      .map((record) => record.searchableText)
      .join('\n')
    const documented = new Set(
      [...keywordText.matchAll(/\$([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1])
    )

    const compatibilityAliases = new Set(['id', 'defaultavatar', 'hours', 'minutes', 'seconds'])
    expect(
      registered.filter((name) => !compatibilityAliases.has(name) && !documented.has(name))
    ).toEqual([])
  })

  it('covers agent-editable modern command fields in the commands category', () => {
    const commandText = documentationIndex.records
      .filter((record) => record.category === 'commands')
      .map((record) => record.searchableText)
      .join('\n')
    const fields = [
      'cooldown',
      'cooldownType',
      'cooldownMessage',
      'channelMessageAsReply',
      'channelEmbedAsReply',
      'channelMessageTyping',
      'channelEmbedTyping',
      'channelWhitelist',
      'serverWhitelist'
    ]

    expect(fields.filter((field) => !commandText.includes(field))).toEqual([])
    expect(commandText).not.toContain('targetUserOptionName')
  })

  it('covers agent-editable interaction fields in the interactions category', () => {
    const interactionText = documentationIndex.records
      .filter((record) => record.category === 'interactions')
      .map((record) => record.searchableText)
      .join('\n')
    const fields = [
      'commandName',
      'commandDescription',
      'options',
      'choices',
      'rootAction',
      'guildId',
      'ephemeral',
      'deferReply',
      'targetUserOptionName',
      'buttons',
      'customId',
      'style'
    ]

    expect(fields.filter((field) => !interactionText.includes(field))).toEqual([])
  })

  it('returns compact searches and complete sections with code examples', () => {
    const result = searchDocumentation('your first command', 'tutorial', 1)
    const match = result.bestMatch!
    expect(match.content).toContain('Hello $name!')
    expect(result.alternatives).toEqual([])

    const section = readDocumentation(match.id)
    expect(section.content).toContain('```\nHello $name! Welcome to $server.\n```')
    expect(section).not.toHaveProperty('searchableText')
  })

  it('finds current fields and keywords by exact name', () => {
    expect(searchDocumentation('$dateDiscord', 'keywords', 1).bestMatch?.id).toContain(
      'currentinterpreter'
    )
    expect(searchDocumentation('targetUserOptionName', 'interactions', 1).bestMatch?.title).toBe(
      'Moderation actions'
    )
    expect(searchDocumentation('customId', 'interactions', 1).bestMatch).toMatchObject({
      title: 'Button fields and styles',
      category: 'interactions',
      sourceUrl: 'https://ayayaq.com/DiscordBots-Help/interactions.html'
    })
  })

  it('recovers from verbose partial queries and bounds result size', () => {
    const result = searchDocumentation('how do I store tic tac toe game state', 'tutorial', 5)
    expect(result.bestMatch?.title).toBe('Persisting State')
    expect(result.alternatives.length).toBeLessThanOrEqual(4)
    expect(result.bestMatch!.content.length).toBeLessThanOrEqual(2_000)
    expect(result.alternatives.every((match) => !('content' in match))).toBe(true)
  })

  it('marks long best matches as truncated and returns a short no-match response', () => {
    const long = searchDocumentation('new legacy interpreter comparison', 'tutorial', 1)
    expect(long.bestMatch?.truncated).toBe(true)
    expect(long.bestMatch?.content.length).toBe(2_000)

    const missing = searchDocumentation('zyxwvuqnotadoc', undefined, 5)
    expect(missing).toMatchObject({ bestMatch: null, alternatives: [] })
    expect(missing.message).toContain('shorter exact')
  })

  it('rejects blank searches and unknown section IDs', () => {
    expect(() => searchDocumentation('   ')).toThrow('cannot be empty')
    expect(() => readDocumentation('missing')).toThrow('not found')
  })
})
