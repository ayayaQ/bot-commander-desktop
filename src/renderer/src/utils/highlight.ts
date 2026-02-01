// Token types for BCFDLang
type BCFDTokenType = 'text' | 'variable' | 'function' | 'args' | 'keyword' | 'eval-content'

interface BCFDToken {
  type: BCFDTokenType
  value: string
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

  function addToken(type: BCFDTokenType, value: string) {
    if (value.length > 0) {
      tokens.push({ type, value })
    }
  }

  while (i < code.length) {
    // Check for $eval block
    if (lookingAt('$eval')) {
      // Consume $eval keyword
      addToken('keyword', '$eval')
      i += 5

      // Find the matching $halt
      let evalContent = ''
      while (i < code.length && !lookingAt('$halt')) {
        evalContent += consume()
      }

      if (evalContent.length > 0) {
        addToken('eval-content', evalContent)
      }

      // Consume $halt if present
      if (lookingAt('$halt')) {
        addToken('keyword', '$halt')
        i += 5
      }
      continue
    }

    // Check for $ prefix (variable or function)
    if (peek() === '$') {
      consume() // consume $

      // Check if followed by identifier
      if (isIdentifierStart(peek())) {
        const name = consumeWhile(isIdentifierChar)

        // Check what follows: ( for function, { for brace-function, or end for variable
        if (peek() === '(') {
          addToken('function', '$' + name)
          const args = consumeBalanced('(', ')')
          addToken('args', args)
        } else if (peek() === '{') {
          addToken('function', '$' + name)
          const args = consumeBalanced('{', '}')
          addToken('args', args)
        } else {
          addToken('variable', '$' + name)
        }
      } else {
        // Lone $ sign, treat as text
        addToken('text', '$')
      }
      continue
    }

    // Regular text - consume until we hit a $ or end
    const text = consumeWhile((char) => char !== '$')
    addToken('text', text)
  }

  return tokens
}

// Render tokens to HTML
function renderBCFDTokens(tokens: BCFDToken[]): string {
  let html = ''

  for (const token of tokens) {
    // Escape HTML in the value
    const escaped = token.value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    switch (token.type) {
      case 'text':
        html += escaped
        break
      case 'variable':
        html += `<span class="bcfd-variable">${escaped}</span>`
        break
      case 'function':
        html += `<span class="bcfd-function">${escaped}</span>`
        break
      case 'args':
        html += `<span class="bcfd-args">${escaped}</span>`
        break
      case 'keyword':
        html += `<span class="bcfd-keyword">${escaped}</span>`
        break
      case 'eval-content':
        // Apply JS highlighting to eval content
        const jsHighlighted = highlightJavaScript(escaped)
        html += `<span class="bcfd-eval">${jsHighlighted}</span>`
        break
    }
  }

  return html
}

export function highlightBCFD(code: string): string {
  const tokens = tokenizeBCFD(code)
  let html = renderBCFDTokens(tokens)

  // Preserve newlines for proper line alignment
  html = html.replace(/\n/g, '<br>')

  // Add trailing space to prevent collapse
  if (html.endsWith('<br>')) {
    html += '&nbsp;'
  }

  return html
}

// Token types for JavaScript
type JSTokenType = 'text' | 'keyword' | 'string' | 'number' | 'comment' | 'builtin' | 'interpolation-bracket'

interface JSToken {
  type: JSTokenType
  value: string
}

const JS_KEYWORDS = new Set([
  'let', 'const', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'default', 'try', 'catch', 'finally',
  'throw', 'new', 'typeof', 'instanceof', 'this', 'null', 'true', 'false',
  'class', 'extends', 'super', 'import', 'from', 'export', 'as', 'await', 'async',
  'yield', 'delete', 'in', 'of', 'with', 'void', 'undefined'
])

const JS_BUILTINS = new Set([
  'Math', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'RegExp', 'console', 'botState'
])

// Character-by-character tokenizer for JavaScript
function tokenizeJS(code: string): JSToken[] {
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

  function addToken(type: JSTokenType, value: string) {
    if (value.length > 0) {
      tokens.push({ type, value })
    }
  }

  while (i < code.length) {
    const char = peek()

    // Single-line comment
    if (char === '/' && peek(1) === '/') {
      let comment = ''
      while (i < code.length && peek() !== '\n') {
        comment += consume()
      }
      addToken('comment', comment)
      continue
    }

    // Multi-line comment
    if (char === '/' && peek(1) === '*') {
      let comment = consume() + consume() // /*
      while (i < code.length && !(peek() === '*' && peek(1) === '/')) {
        comment += consume()
      }
      if (i < code.length) {
        comment += consume() + consume() // */
      }
      addToken('comment', comment)
      continue
    }

    // Template literal
    if (char === '`') {
      let str = consume() // opening `
      while (i < code.length && peek() !== '`') {
        if (peek() === '\\' && i + 1 < code.length) {
          str += consume() + consume() // escape sequence
        } else if (peek() === '$' && peek(1) === '{') {
          // End current string token
          addToken('string', str)
          str = ''

          // Add interpolation opening bracket
          addToken('interpolation-bracket', '${')
          i += 2

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
          const innerTokens = tokenizeJS(interpolationContent)
          tokens.push(...innerTokens)

          // Add closing bracket
          if (peek() === '}') {
            addToken('interpolation-bracket', '}')
            consume()
          }

          // Continue building string after interpolation
          str = ''
        } else {
          str += consume()
        }
      }
      if (peek() === '`') {
        str += consume() // closing `
      }
      addToken('string', str)
      continue
    }

    // Double-quoted string
    if (char === '"') {
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
      addToken('string', str)
      continue
    }

    // Single-quoted string
    if (char === "'") {
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
      addToken('string', str)
      continue
    }

    // Number
    if (isDigit(char) || (char === '.' && isDigit(peek(1)))) {
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
      addToken('number', num)
      continue
    }

    // Identifier or keyword
    if (isIdentifierStart(char)) {
      let ident = ''
      while (i < code.length && isIdentifierChar(peek())) {
        ident += consume()
      }
      if (JS_KEYWORDS.has(ident)) {
        addToken('keyword', ident)
      } else if (JS_BUILTINS.has(ident)) {
        addToken('builtin', ident)
      } else {
        addToken('text', ident)
      }
      continue
    }

    // Everything else (operators, punctuation, whitespace)
    addToken('text', consume())
  }

  return tokens
}

// Render JS tokens to HTML
function renderJSTokens(tokens: JSToken[]): string {
  let html = ''

  for (const token of tokens) {
    // Escape HTML in the value
    const escaped = token.value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')

    switch (token.type) {
      case 'text':
        html += escaped
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

export function highlightJavaScript(code: string): string {
  const tokens = tokenizeJS(code)
  return renderJSTokens(tokens)
}
