// Token types for BCFDLang
type BCFDTokenType = 'text' | 'variable' | 'function' | 'args' | 'keyword' | 'eval-content'

interface BCFDToken {
  type: BCFDTokenType
  value: string
  position: number
}

interface BCFDHighlightDiagnostic {
  message: string
  position: number
}

// Character-by-character tokenizer for BCFDLang
function tokenizeBCFD(code: string): BCFDToken[] {
  const tokens: BCFDToken[] = []
  let i = 0

  function peek(offset = 0): string {
    return code[i + offset] ?? ''
  }

  function consume(): string {
    return code[i++] ?? ''
  }

  function consumeWhile(predicate: (char: string) => boolean): string {
    let result = ''
    while (i < code.length && predicate(peek())) {
      result += consume()
    }
    return result
  }

  function isIdentifierStart(char: string): boolean {
    return /[a-zA-Z_]/.test(char)
  }

  function isIdentifierChar(char: string): boolean {
    return /[a-zA-Z0-9_]/.test(char)
  }

  // Check if we're at a specific string
  function lookingAt(str: string): boolean {
    for (let j = 0; j < str.length; j++) {
      if (peek(j) !== str[j]) return false
    }
    return true
  }

  // Consume balanced content between open/close chars, tracking depth
  function consumeBalanced(openChar: string, closeChar: string): string {
    let result = ''
    let depth = 1
    consume() // consume opening char
    result += openChar

    while (i < code.length && depth > 0) {
      const char = peek()
      if (char === openChar) {
        depth++
      } else if (char === closeChar) {
        depth--
      }
      result += consume()
    }

    return result
  }

  function addToken(type: BCFDTokenType, value: string, position: number) {
    if (value.length > 0) {
      tokens.push({ type, value, position })
    }
  }

  while (i < code.length) {
    // Check for $eval block
    if (lookingAt('$eval')) {
      // Consume $eval keyword
      addToken('keyword', '$eval', i)
      i += 5

      // Find the matching $halt
      let evalContent = ''
      const evalContentPosition = i
      while (i < code.length && !lookingAt('$halt')) {
        evalContent += consume()
      }

      if (evalContent.length > 0) {
        addToken('eval-content', evalContent, evalContentPosition)
      }

      // Consume $halt if present
      if (lookingAt('$halt')) {
        addToken('keyword', '$halt', i)
        i += 5
      }
      continue
    }

    // Check for $ prefix (variable or function)
    if (peek() === '$') {
      const dollarPosition = i
      consume() // consume $

      // Check if followed by identifier
      if (isIdentifierStart(peek())) {
        const name = consumeWhile(isIdentifierChar)

        // Check what follows: ( for function, { for brace-function, or end for variable
        if (peek() === '(') {
          addToken('function', '$' + name, dollarPosition)
          const argsPosition = i
          const args = consumeBalanced('(', ')')
          addToken('args', args, argsPosition)
        } else if (peek() === '{') {
          addToken('function', '$' + name, dollarPosition)
          const argsPosition = i
          const args = consumeBalanced('{', '}')
          addToken('args', args, argsPosition)
        } else {
          addToken('variable', '$' + name, dollarPosition)
        }
      } else {
        // Lone $ sign, treat as text
        addToken('text', '$', dollarPosition)
      }
      continue
    }

    // Regular text - consume until we hit a $ or end
    const textPosition = i
    const text = consumeWhile((char) => char !== '$')
    addToken('text', text, textPosition)
  }

  return tokens
}

function escapeHTML(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeHTML(value).replace(/"/g, '&quot;')
}

// Render tokens to HTML
function renderBCFDTokens(
  tokens: BCFDToken[],
  diagnostics: BCFDHighlightDiagnostic[] = []
): string {
  let html = ''
  const diagnosticByPosition = new Map(
    diagnostics.map((diagnostic) => [diagnostic.position, diagnostic])
  )

  for (const token of tokens) {
    // Escape HTML in the value
    const escaped = escapeHTML(token.value)
    const diagnostic = diagnosticByPosition.get(token.position)

    switch (token.type) {
      case 'text':
        html += escaped
        break
      case 'variable':
        html += diagnostic
          ? `<span class="bcfd-variable bcfd-warning" title="${escapeAttribute(diagnostic.message)}">${escaped}</span>`
          : `<span class="bcfd-variable">${escaped}</span>`
        break
      case 'function':
        html += diagnostic
          ? `<span class="bcfd-function bcfd-warning" title="${escapeAttribute(diagnostic.message)}">${escaped}</span>`
          : `<span class="bcfd-function">${escaped}</span>`
        break
      case 'args':
        html += `<span class="bcfd-args">${escaped}</span>`
        break
      case 'keyword':
        html += `<span class="bcfd-keyword">${escaped}</span>`
        break
      case 'eval-content':
        // Apply JS highlighting to eval content
        const jsHighlighted = highlightJavaScript(token.value, diagnostics, token.position)
        html += `<span class="bcfd-eval">${jsHighlighted}</span>`
        break
    }
  }

  return html
}

export function highlightBCFD(code: string, diagnostics: BCFDHighlightDiagnostic[] = []): string {
  const tokens = tokenizeBCFD(code)
  let html = renderBCFDTokens(tokens, diagnostics)

  // Preserve newlines for proper line alignment
  html = html.replace(/\n/g, '<br>')

  // Add trailing space to prevent collapse
  if (html.endsWith('<br>')) {
    html += '&nbsp;'
  }

  return html
}

// Token types for JavaScript
type JSTokenType =
  | 'text'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'builtin'
  | 'interpolation-bracket'

interface JSToken {
  type: JSTokenType
  value: string
  position: number
}

const JS_KEYWORDS = new Set([
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
  'void',
  'undefined'
])

const JS_BUILTINS = new Set([
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
])

// Character-by-character tokenizer for JavaScript
function tokenizeJS(code: string, basePosition = 0): JSToken[] {
  const tokens: JSToken[] = []
  let i = 0

  function peek(offset = 0): string {
    return code[i + offset] ?? ''
  }

  function consume(): string {
    return code[i++] ?? ''
  }

  function isIdentifierStart(char: string): boolean {
    return /[a-zA-Z_$]/.test(char)
  }

  function isIdentifierChar(char: string): boolean {
    return /[a-zA-Z0-9_$]/.test(char)
  }

  function isDigit(char: string): boolean {
    return /[0-9]/.test(char)
  }

  function addToken(type: JSTokenType, value: string, position: number) {
    if (value.length > 0) {
      tokens.push({ type, value, position: basePosition + position })
    }
  }

  while (i < code.length) {
    const char = peek()

    // Single-line comment
    if (char === '/' && peek(1) === '/') {
      const tokenPosition = i
      let comment = ''
      while (i < code.length && peek() !== '\n') {
        comment += consume()
      }
      addToken('comment', comment, tokenPosition)
      continue
    }

    // Multi-line comment
    if (char === '/' && peek(1) === '*') {
      const tokenPosition = i
      let comment = consume() + consume() // /*
      while (i < code.length && !(peek() === '*' && peek(1) === '/')) {
        comment += consume()
      }
      if (i < code.length) {
        comment += consume() + consume() // */
      }
      addToken('comment', comment, tokenPosition)
      continue
    }

    // Template literal
    if (char === '`') {
      let strPosition = i
      let str = consume() // opening `
      while (i < code.length && peek() !== '`') {
        if (peek() === '\\' && i + 1 < code.length) {
          str += consume() + consume() // escape sequence
        } else if (peek() === '$' && peek(1) === '{') {
          // End current string token
          addToken('string', str, strPosition)
          str = ''

          // Add interpolation opening bracket
          addToken('interpolation-bracket', '${', i)
          i += 2
          const interpolationPosition = i

          // Find matching closing brace, tracking depth
          let depth = 1
          let interpolationContent = ''
          while (i < code.length && depth > 0) {
            if (peek() === '{') {
              depth++
              interpolationContent += consume()
            } else if (peek() === '}') {
              depth--
              if (depth > 0) {
                interpolationContent += consume()
              }
            } else {
              interpolationContent += consume()
            }
          }

          // Recursively tokenize interpolation content
          const innerTokens = tokenizeJS(interpolationContent, basePosition + interpolationPosition)
          tokens.push(...innerTokens)

          // Add closing bracket
          if (peek() === '}') {
            addToken('interpolation-bracket', '}', i)
            consume()
          }

          // Continue building string after interpolation
          strPosition = i
          str = ''
        } else {
          str += consume()
        }
      }
      if (peek() === '`') {
        str += consume() // closing `
      }
      addToken('string', str, strPosition)
      continue
    }

    // Double-quoted string
    if (char === '"') {
      const tokenPosition = i
      let str = consume() // opening "
      while (i < code.length && peek() !== '"') {
        if (peek() === '\\' && i + 1 < code.length) {
          str += consume() + consume() // escape sequence
        } else if (peek() === '\n') {
          break // unterminated string
        } else {
          str += consume()
        }
      }
      if (peek() === '"') {
        str += consume() // closing "
      }
      addToken('string', str, tokenPosition)
      continue
    }

    // Single-quoted string
    if (char === "'") {
      const tokenPosition = i
      let str = consume() // opening '
      while (i < code.length && peek() !== "'") {
        if (peek() === '\\' && i + 1 < code.length) {
          str += consume() + consume() // escape sequence
        } else if (peek() === '\n') {
          break // unterminated string
        } else {
          str += consume()
        }
      }
      if (peek() === "'") {
        str += consume() // closing '
      }
      addToken('string', str, tokenPosition)
      continue
    }

    // Number
    if (isDigit(char) || (char === '.' && isDigit(peek(1)))) {
      const tokenPosition = i
      let num = ''
      // Integer part
      while (i < code.length && isDigit(peek())) {
        num += consume()
      }
      // Decimal part
      if (peek() === '.' && isDigit(peek(1))) {
        num += consume() // .
        while (i < code.length && isDigit(peek())) {
          num += consume()
        }
      }
      // Exponent part
      if (peek() === 'e' || peek() === 'E') {
        num += consume()
        if (peek() === '+' || peek() === '-') {
          num += consume()
        }
        while (i < code.length && isDigit(peek())) {
          num += consume()
        }
      }
      addToken('number', num, tokenPosition)
      continue
    }

    // Identifier or keyword
    if (isIdentifierStart(char)) {
      const tokenPosition = i
      let ident = ''
      while (i < code.length && isIdentifierChar(peek())) {
        ident += consume()
      }
      if (JS_KEYWORDS.has(ident)) {
        addToken('keyword', ident, tokenPosition)
      } else if (JS_BUILTINS.has(ident)) {
        addToken('builtin', ident, tokenPosition)
      } else {
        addToken('text', ident, tokenPosition)
      }
      continue
    }

    // Everything else (operators, punctuation, whitespace)
    const tokenPosition = i
    addToken('text', consume(), tokenPosition)
  }

  return tokens
}

// Render JS tokens to HTML
function renderJSTokens(tokens: JSToken[], diagnostics: BCFDHighlightDiagnostic[] = []): string {
  let html = ''
  const diagnosticByPosition = new Map(
    diagnostics.map((diagnostic) => [diagnostic.position, diagnostic])
  )

  for (const token of tokens) {
    // Escape HTML in the value
    const escaped = token.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    const diagnostic = diagnosticByPosition.get(token.position)

    switch (token.type) {
      case 'text':
        html += diagnostic
          ? `<span class="bcfd-warning" title="${escapeAttribute(diagnostic.message)}">${escaped}</span>`
          : escaped
        break
      case 'keyword':
        html += `<span class="js-keyword">${escaped}</span>`
        break
      case 'string':
        html += `<span class="js-string">${escaped}</span>`
        break
      case 'number':
        html += `<span class="js-number">${escaped}</span>`
        break
      case 'comment':
        html += `<span class="js-comment">${escaped}</span>`
        break
      case 'builtin':
        html += `<span class="js-builtin">${escaped}</span>`
        break
      case 'interpolation-bracket':
        html += `<span class="bcfd-args">${escaped}</span>`
        break
    }
  }

  return html
}

export function highlightJavaScript(
  code: string,
  diagnostics: BCFDHighlightDiagnostic[] = [],
  basePosition = 0
): string {
  const tokens = tokenizeJS(code, basePosition)
  return renderJSTokens(tokens, diagnostics)
}
