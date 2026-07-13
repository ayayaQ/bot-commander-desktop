import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = path.resolve(SCRIPT_DIR, '..')
const sourceDir = path.resolve(PROJECT_DIR, process.argv[2] || '../DiscordBots-Help')
const outputPath = path.join(PROJECT_DIR, 'src/main/generated/documentationIndex.json')
const pages = ['creating', 'commands', 'keywords', 'tutorial', 'webhooks']

function nestedValue(value, key) {
  return key.split('.').reduce((current, part) => current?.[part], value)
}

function cleanText(value) {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanMarkdown(value) {
  return value
    .split(/(```[\s\S]*?```)/g)
    .map((part) =>
      part.startsWith('```')
        ? part.trim()
        : part
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    )
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function renderNode($, node) {
  if (node.type === 'text') return node.data || ''
  if (node.type !== 'tag') return ''

  const name = node.name.toLowerCase()
  if (['script', 'style', 'img'].includes(name)) return ''
  if (name === 'br') return '\n'
  if (name === 'pre') return `\n\`\`\`\n${$(node).text().trim()}\n\`\`\`\n`

  const content = node.children.map((child) => renderNode($, child)).join('')
  if (name === 'li') return `\n- ${cleanText(content)}`
  if (['p', 'div', 'ol', 'ul'].includes(name)) return `\n${content}\n`
  if (/^h[1-6]$/.test(name)) return `\n${'#'.repeat(Number(name[1]))} ${cleanText(content)}\n`
  if (name === 'code') return `\`${content}\``
  if (name === 'a') {
    const href = $(node).attr('href')
    return href ? `[${cleanText(content)}](${href})` : content
  }
  return content
}

function renderSelection($, selection) {
  return cleanMarkdown(
    selection
      .toArray()
      .map((node) => renderNode($, node))
      .join('\n')
  )
}

function stableId(page, key) {
  const normalized = key
    .replace(/\.(name|title|heading|desc|compat)$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
  return `${page}:${normalized || 'section'}`
}

function sourceRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function addRecord(records, { page, idKey, title, breadcrumbs, content }) {
  if (!title || !content) return
  const sourceUrl = `https://ayayaq.com/DiscordBots-Help/${page}.html`
  records.push({
    id: stableId(page, idKey),
    title,
    category: page,
    breadcrumbs,
    content,
    searchableText: [title, ...breadcrumbs, content].join('\n'),
    sourceUrl
  })
}

async function generate() {
  const sourceHash = crypto.createHash('sha256')
  const localeSource = await fs.readFile(path.join(sourceDir, 'locales/en.json'), 'utf8')
  sourceHash.update(localeSource)
  const translations = JSON.parse(localeSource)
  const records = []

  for (const page of pages) {
    const html = await fs.readFile(path.join(sourceDir, `${page}.html`), 'utf8')
    sourceHash.update(html)
    const $ = cheerio.load(html)
    $('[data-i18n]').each((_, element) => {
      const key = $(element).attr('data-i18n')
      const translated = key ? nestedValue(translations, key) : undefined
      if (typeof translated === 'string') $(element).html(translated)
    })

    const pageTitle = cleanText($('header h1').first().text()) || page
    $('button.collapsible').each((sectionIndex, button) => {
      const buttonSelection = $(button)
      const sectionKey =
        buttonSelection.attr('data-doc-id') ||
        buttonSelection.find('[data-i18n]').first().attr('data-i18n') ||
        `${page}.${sectionIndex}`
      const sectionTitle = cleanText(buttonSelection.text())
      const sectionContent = buttonSelection.next('.content')
      if (!sectionContent.length) return

      if (page === 'commands' || page === 'keywords') {
        sectionContent.children('.keyword').each((itemIndex, item) => {
          const itemSelection = $(item)
          const titleElement = itemSelection.find('h2, h3').first()
          const itemTitle = cleanText(titleElement.text()) || `${sectionTitle} ${itemIndex + 1}`
          const itemKey =
            itemSelection.attr('data-doc-id') ||
            titleElement.attr('data-i18n') ||
            `${sectionKey}.${itemIndex}`
          addRecord(records, {
            page,
            idKey: itemKey,
            title: itemTitle,
            breadcrumbs: [pageTitle, sectionTitle],
            content: renderSelection($, itemSelection)
          })
        })
      } else {
        addRecord(records, {
          page,
          idKey: sectionKey,
          title: sectionTitle,
          breadcrumbs: [pageTitle],
          content: renderSelection($, sectionContent)
        })
      }
    })
  }

  const ids = new Set()
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Duplicate documentation ID: ${record.id}`)
    ids.add(record.id)
  }

  const output = {
    schemaVersion: 1,
    language: 'en',
    sourceRevision: sourceRevision(),
    sourceContentHash: sourceHash.digest('hex'),
    records
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(
    `Wrote ${records.length} documentation records to ${path.relative(PROJECT_DIR, outputPath)}`
  )
}

await generate()
