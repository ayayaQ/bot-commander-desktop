import { bcfdItemNames } from './bcfdLanguage'

export interface BCFDLintDiagnostic {
  severity: 'warning'
  message: string
  position: number
  length: number
  name: string
}

interface BCFDLintOptions {
  mode?: 'bcfd' | 'js'
}

function isIdentifierStart(char: string): boolean {
  return /[a-zA-Z_]/.test(char)
}

function isIdentifierChar(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char)
}

function addUnknownDiagnostic(
  diagnostics: BCFDLintDiagnostic[],
  input: string,
  position: number,
  nameEnd: number
) {
  const name = input.slice(position + 1, nameEnd)
  if (bcfdItemNames.has(name)) return

  const nextChar = input[nameEnd]
  const kind = nextChar === '(' || nextChar === '{' ? 'function' : 'variable'

  diagnostics.push({
    severity: 'warning',
    message: `Unknown BCFD ${kind} "$${name}"`,
    position,
    length: nameEnd - position,
    name
  })
}

function skipQuotedString(input: string, position: number, end: number, quote: '"' | "'"): number {
  position++

  while (position < end) {
    const char = input[position]

    if (char === '\\') {
      position += 2
      continue
    }

    if (char === quote) {
      return position + 1
    }

    if (char === '\n') {
      return position
    }

    position++
  }

  return position
}

function scanTemplateLiteral(
  input: string,
  position: number,
  end: number,
  diagnostics: BCFDLintDiagnostic[]
): number {
  position++

  while (position < end) {
    const char = input[position]

    if (char === '\\') {
      position += 2
      continue
    }

    if (char === '`') {
      return position + 1
    }

    if (char === '$' && input[position + 1] === '{') {
      position = scanJavaScript(input, position + 2, end, diagnostics, true)
      if (input[position] === '}') {
        position++
      }
      continue
    }

    position++
  }

  return position
}

function scanJavaScript(
  input: string,
  start: number,
  end: number,
  diagnostics: BCFDLintDiagnostic[],
  stopAtClosingBrace = false
): number {
  let position = start

  while (position < end) {
    const char = input[position]

    if (stopAtClosingBrace && char === '}') {
      return position
    }

    if (stopAtClosingBrace && char === '{') {
      position = scanJavaScript(input, position + 1, end, diagnostics, true)
      if (input[position] === '}') {
        position++
      }
      continue
    }

    if (char === '/' && input[position + 1] === '/') {
      position += 2
      while (position < end && input[position] !== '\n') {
        position++
      }
      continue
    }

    if (char === '/' && input[position + 1] === '*') {
      position += 2
      while (position < end && !(input[position] === '*' && input[position + 1] === '/')) {
        position++
      }
      position = Math.min(position + 2, end)
      continue
    }

    if (char === '"' || char === "'") {
      position = skipQuotedString(input, position, end, char)
      continue
    }

    if (char === '`') {
      position = scanTemplateLiteral(input, position, end, diagnostics)
      continue
    }

    if (char === '$') {
      if (input[position + 1] === '$') {
        position += 2
        continue
      }

      const nameStart = position + 1
      if (!isIdentifierStart(input[nameStart] ?? '')) {
        position++
        continue
      }

      let nameEnd = nameStart + 1
      while (nameEnd < end && isIdentifierChar(input[nameEnd])) {
        nameEnd++
      }

      addUnknownDiagnostic(diagnostics, input, position, nameEnd)
      position = nameEnd
      continue
    }

    position++
  }

  return position
}

function scanBCFD(input: string, start: number, end: number, diagnostics: BCFDLintDiagnostic[]) {
  let position = start

  while (position < end) {
    const char = input[position]

    if (char !== '$') {
      position++
      continue
    }

    if (input[position + 1] === '$') {
      position += 2
      continue
    }

    const nameStart = position + 1
    if (!isIdentifierStart(input[nameStart] ?? '')) {
      position++
      continue
    }

    let nameEnd = nameStart + 1
    while (nameEnd < end && isIdentifierChar(input[nameEnd])) {
      nameEnd++
    }

    const name = input.slice(nameStart, nameEnd)

    if (name === 'eval') {
      const haltPosition = input.indexOf('$halt', nameEnd)
      const evalEnd = haltPosition === -1 ? end : Math.min(haltPosition, end)
      scanJavaScript(input, nameEnd, evalEnd, diagnostics)
      position = haltPosition === -1 ? evalEnd : haltPosition + '$halt'.length
      continue
    }

    addUnknownDiagnostic(diagnostics, input, position, nameEnd)
    position = nameEnd
  }
}

export function lintBCFD(input: string, options: BCFDLintOptions = {}): BCFDLintDiagnostic[] {
  const diagnostics: BCFDLintDiagnostic[] = []

  if (options.mode === 'js') {
    scanJavaScript(input, 0, input.length, diagnostics)
  } else {
    scanBCFD(input, 0, input.length, diagnostics)
  }

  return diagnostics
}
