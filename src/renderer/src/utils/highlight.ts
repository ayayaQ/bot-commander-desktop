export function highlightBCFD(code: string): string {
  // Escape HTML first
  let html = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Highlight $eval ... $halt blocks with JS syntax highlighting inside
  html = html.replace(/(\$eval)([\s\S]*?)(\$halt)/g, (_, evalKeyword, content, haltKeyword) => {
    const highlightedContent = highlightJavaScript(content)
    return `<span class="bcfd-keyword">${evalKeyword}</span><span class="bcfd-eval">${highlightedContent}</span><span class="bcfd-keyword">${haltKeyword}</span>`
  })

  // Highlight functions with parentheses: $name(...)
  html = html.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_]*)(\([^)]*\))/g,
    (_, name, args) =>
      `<span class="bcfd-function">$${name}</span><span class="bcfd-args">${args}</span>`
  )

  // Highlight functions with braces: $name{...}
  html = html.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_]*)(\{[^}]*\})/g,
    (_, name, args) =>
      `<span class="bcfd-function">$${name}</span><span class="bcfd-args">${args}</span>`
  )

  // Highlight remaining variables: $name
  html = html.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_]*)/g,
    (_, name) => `<span class="bcfd-variable">$${name}</span>`
  )

  // Preserve newlines for proper line alignment
  html = html.replace(/\n/g, '<br>')

  // Add trailing space to prevent collapse
  if (html.endsWith('<br>')) {
    html += '&nbsp;'
  }

  return html
}

function highlightJavaScript(code: string): string {
  // Use unique placeholder markers that won't appear in code
  const placeholders: Map<string, string> = new Map()
  let placeholderIndex = 0

  function addPlaceholder(html: string): string {
    const placeholder = `\uE000PH${placeholderIndex++}PH\uE001`
    placeholders.set(placeholder, html)
    return placeholder
  }

  let result = code

  // Highlight strings (double quotes) - must come before other patterns
  result = result.replace(/"([^"\\]|\\.)*"/g, (match) =>
    addPlaceholder(`<span class="js-string">${match}</span>`)
  )

  // Highlight strings (single quotes)
  result = result.replace(/'([^'\\]|\\.)*'/g, (match) =>
    addPlaceholder(`<span class="js-string">${match}</span>`)
  )

  // Highlight template literals (backticks)
  result = result.replace(/`([^`\\]|\\.)*`/g, (match) =>
    addPlaceholder(`<span class="js-string">${match}</span>`)
  )

  // Highlight single-line comments
  result = result.replace(/\/\/[^\n]*/g, (match) =>
    addPlaceholder(`<span class="js-comment">${match}</span>`)
  )

  // Highlight multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    addPlaceholder(`<span class="js-comment">${match}</span>`)
  )

  // Highlight numbers
  result = result.replace(/\b(\d+\.?\d*)\b/g, (match) =>
    addPlaceholder(`<span class="js-number">${match}</span>`)
  )

  // Highlight keywords
  const keywords = [
    'let',
    'const',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'default',
    'try',
    'catch',
    'finally',
    'throw',
    'new',
    'typeof',
    'instanceof',
    'this',
    'null',
    'true',
    'false',
    'class',
    'extends',
    'super',
    'import',
    'from',
    'export',
    'as',
    'await',
    'async',
    'yield',
    'delete',
    'in',
    'of',
    'with',
    'void'
  ]

  const keywordRegex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g')
  result = result.replace(keywordRegex, (match) =>
    addPlaceholder(`<span class="js-keyword">${match}</span>`)
  )

  // Highlight built-in objects
  const builtins = [
    'Math',
    'JSON',
    'Array',
    'Object',
    'String',
    'Number',
    'Boolean',
    'Date',
    'RegExp',
    'console',
    'botState'
  ]
  const builtinPattern = new RegExp(`\\b(${builtins.join('|')})\\b`, 'g')
  result = result.replace(builtinPattern, (match) =>
    addPlaceholder(`<span class="js-builtin">${match}</span>`)
  )

  // Restore placeholders
  placeholders.forEach((htmlValue, placeholder) => {
    result = result.replace(placeholder, htmlValue)
  })

  return result
}
