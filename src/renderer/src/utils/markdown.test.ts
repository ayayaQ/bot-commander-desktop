import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('safe markdown rendering', () => {
  it('renders common markdown structures', () => {
    const html = renderMarkdown('## Result\n\n- **One**\n- `two`')
    expect(html).toContain('<h2>Result</h2>')
    expect(html).toContain('<strong>One</strong>')
    expect(html).toContain('<code>two</code>')
  })

  it('escapes raw HTML and removes unsafe links', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n[run](javascript:alert(1))')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('&lt;script&gt;')
  })

  it('opens safe links externally without exposing the opener', () => {
    const html = renderMarkdown('[Docs](https://example.com/docs)')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})
