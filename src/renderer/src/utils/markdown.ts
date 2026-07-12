import { marked, Renderer } from 'marked'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol)
  } catch {
    return false
  }
}

const renderer = new Renderer()

renderer.html = ({ text }) => escapeHtml(text)

renderer.link = function ({ href, title, tokens }) {
  const label = this.parser.parseInline(tokens)
  if (!safeExternalUrl(href)) return label
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : ''
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>${label}</a>`
}

renderer.image = ({ text }) => `<span class="opacity-70">[Image: ${escapeHtml(text || 'untitled')}]</span>`

export function renderMarkdown(content: string): string {
  return marked.parse(content, {
    async: false,
    breaks: true,
    gfm: true,
    renderer
  }) as string
}
