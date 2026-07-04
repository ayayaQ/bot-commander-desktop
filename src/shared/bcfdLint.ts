import { bcfdItemNames } from './bcfdLanguage'
import { parse } from 'acorn'

export interface BCFDLintDiagnostic {
  severity: 'warning' | 'error'
  message: string
  position: number
  length: number
  name: string
}

interface BCFDLintOptions {
  mode?: 'bcfd' | 'js'
  startupJs?: string
  additionalGlobals?: string[]
  lintJavaScript?: boolean
}

type JavaScriptNode = {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

class Scope {
  readonly names = new Set<string>()
  readonly functionScope: Scope

  constructor(
    readonly parent: Scope | null = null,
    isFunctionScope = false
  ) {
    this.functionScope = isFunctionScope || !parent ? this : parent.functionScope
  }

  declare(name: string) {
    this.names.add(name)
  }

  has(name: string): boolean {
    return this.names.has(name) || !!this.parent?.has(name)
  }
}

const DEFAULT_JS_GLOBALS = new Set([
  'globalThis',
  'undefined',
  'NaN',
  'Infinity',
  'Math',
  'JSON',
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Symbol',
  'BigInt',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
  'console',
  'botState',
  'debug'
])

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

function addJavaScriptDiagnostic(
  diagnostics: BCFDLintDiagnostic[],
  severity: BCFDLintDiagnostic['severity'],
  message: string,
  position: number,
  length: number,
  name = 'javascript'
) {
  diagnostics.push({
    severity,
    message,
    position,
    length: Math.max(1, length),
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

function replaceRangeWithPlaceholder(chars: string[], start: number, end: number) {
  for (let index = start; index < end; index++) {
    chars[index] = index === start ? '0' : ' '
  }
}

function skipLineComment(input: string, position: number, end: number): number {
  position += 2
  while (position < end && input[position] !== '\n') {
    position++
  }
  return position
}

function skipBlockComment(input: string, position: number, end: number): number {
  position += 2
  while (position < end && !(input[position] === '*' && input[position + 1] === '/')) {
    position++
  }
  return Math.min(position + 2, end)
}

function skipQuotedStringForSanitize(
  input: string,
  position: number,
  end: number,
  quote: '"' | "'"
): number {
  position++

  while (position < end) {
    if (input[position] === '\\') {
      position += 2
      continue
    }

    if (input[position] === quote) {
      return position + 1
    }

    position++
  }

  return position
}

function findBalancedEnd(
  input: string,
  position: number,
  end: number,
  open: string,
  close: string
) {
  let depth = 0

  while (position < end) {
    const char = input[position]

    if (char === '/' && input[position + 1] === '/') {
      position = skipLineComment(input, position, end)
      continue
    }

    if (char === '/' && input[position + 1] === '*') {
      position = skipBlockComment(input, position, end)
      continue
    }

    if (char === '"' || char === "'") {
      position = skipQuotedStringForSanitize(input, position, end, char)
      continue
    }

    if (char === '`') {
      position = findTemplateEnd(input, position, end)
      continue
    }

    if (char === open) {
      depth++
    } else if (char === close) {
      depth--
      if (depth === 0) {
        return position + 1
      }
    }

    position++
  }

  return position
}

function findTemplateEnd(input: string, position: number, end: number): number {
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
      position = findBalancedEnd(input, position + 1, end, '{', '}')
      continue
    }

    position++
  }

  return position
}

function sanitizeJavaScriptForParsing(input: string, start: number, end: number): string {
  const chars = input.slice(start, end).split('')

  function sanitizeRange(rangeStart: number, rangeEnd: number, stopAtClosingBrace = false): number {
    let position = rangeStart

    while (position < rangeEnd) {
      const char = input[position]

      if (stopAtClosingBrace && char === '}') {
        return position
      }

      if (char === '/' && input[position + 1] === '/') {
        position = skipLineComment(input, position, rangeEnd)
        continue
      }

      if (char === '/' && input[position + 1] === '*') {
        position = skipBlockComment(input, position, rangeEnd)
        continue
      }

      if (char === '"' || char === "'") {
        position = skipQuotedStringForSanitize(input, position, rangeEnd, char)
        continue
      }

      if (char === '`') {
        position++
        while (position < rangeEnd) {
          if (input[position] === '\\') {
            position += 2
            continue
          }

          if (input[position] === '`') {
            position++
            break
          }

          if (input[position] === '$' && input[position + 1] === '{') {
            position = sanitizeRange(position + 2, rangeEnd, true)
            if (input[position] === '}') {
              position++
            }
            continue
          }

          position++
        }
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
        while (nameEnd < rangeEnd && isIdentifierChar(input[nameEnd])) {
          nameEnd++
        }

        let expressionEnd = nameEnd
        const nextChar = input[expressionEnd]
        if (nextChar === '(') {
          expressionEnd = findBalancedEnd(input, expressionEnd, rangeEnd, '(', ')')
        } else if (nextChar === '{') {
          expressionEnd = findBalancedEnd(input, expressionEnd, rangeEnd, '{', '}')
        }

        replaceRangeWithPlaceholder(chars, position - start, expressionEnd - start)
        position = expressionEnd
        continue
      }

      position++
    }

    return position
  }

  sanitizeRange(start, end)
  return chars.join('')
}

function parseJavaScript(input: string): JavaScriptNode | null {
  return parse(input, {
    ecmaVersion: 'latest',
    allowReturnOutsideFunction: true,
    sourceType: 'script'
  }) as unknown as JavaScriptNode
}

function syntaxErrorPosition(error: unknown): number {
  return typeof error === 'object' &&
    error !== null &&
    'pos' in error &&
    typeof (error as { pos: unknown }).pos === 'number'
    ? (error as { pos: number }).pos
    : 0
}

function syntaxErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid JavaScript syntax'
}

function collectPatternNames(pattern: unknown, names: Set<string>) {
  if (!isNode(pattern)) return

  switch (pattern.type) {
    case 'Identifier':
      names.add(getName(pattern))
      break
    case 'RestElement':
      collectPatternNames(pattern.argument, names)
      break
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, names)
      break
    case 'ArrayPattern':
      for (const element of getArray(pattern.elements)) {
        collectPatternNames(element, names)
      }
      break
    case 'ObjectPattern':
      for (const property of getArray(pattern.properties)) {
        if (!isNode(property)) continue
        if (property.type === 'RestElement') {
          collectPatternNames(property.argument, names)
        } else {
          collectPatternNames(property.value, names)
        }
      }
      break
  }
}

function isNode(value: unknown): value is JavaScriptNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  )
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function getName(node: JavaScriptNode): string {
  return typeof node.name === 'string' ? node.name : ''
}

function declarePattern(pattern: unknown, scope: Scope) {
  const names = new Set<string>()
  collectPatternNames(pattern, names)
  for (const name of names) {
    scope.declare(name)
  }
}

function declareFunction(functionNode: JavaScriptNode, scope: Scope) {
  const id = functionNode.id
  if (isNode(id) && id.type === 'Identifier') {
    scope.declare(getName(id))
  }
}

function declareTopLevel(node: JavaScriptNode, scope: Scope) {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      declareFunction(node, scope)
      break
    case 'VariableDeclaration':
      for (const declaration of getArray(node.declarations)) {
        if (isNode(declaration)) {
          declarePattern(declaration.id, node.kind === 'var' ? scope.functionScope : scope)
        }
      }
      break
  }
}

function declareBlockNames(statements: unknown[], scope: Scope) {
  for (const statement of statements) {
    if (isNode(statement)) {
      declareTopLevel(statement, scope)
    }
  }
}

function isAllowedGlobal(name: string, allowedGlobals: Set<string>) {
  return allowedGlobals.has(name)
}

function reportRead(
  node: JavaScriptNode,
  scope: Scope,
  allowedGlobals: Set<string>,
  diagnostics: BCFDLintDiagnostic[],
  offset: number
) {
  const name = getName(node)
  if (!name || scope.has(name) || isAllowedGlobal(name, allowedGlobals)) return

  addJavaScriptDiagnostic(
    diagnostics,
    'warning',
    `Undeclared JavaScript variable "${name}"`,
    offset + node.start,
    node.end - node.start,
    name
  )
}

function visitPatternDefaults(
  pattern: unknown,
  scope: Scope,
  allowedGlobals: Set<string>,
  diagnostics: BCFDLintDiagnostic[],
  offset: number
) {
  if (!isNode(pattern)) return

  switch (pattern.type) {
    case 'AssignmentPattern':
      visitExpression(pattern.right, scope, allowedGlobals, diagnostics, offset)
      visitPatternDefaults(pattern.left, scope, allowedGlobals, diagnostics, offset)
      break
    case 'ArrayPattern':
      for (const element of getArray(pattern.elements)) {
        visitPatternDefaults(element, scope, allowedGlobals, diagnostics, offset)
      }
      break
    case 'ObjectPattern':
      for (const property of getArray(pattern.properties)) {
        if (!isNode(property)) continue
        if (property.type === 'Property') {
          if (property.computed) {
            visitExpression(property.key, scope, allowedGlobals, diagnostics, offset)
          }
          visitPatternDefaults(property.value, scope, allowedGlobals, diagnostics, offset)
        } else if (property.type === 'RestElement') {
          visitPatternDefaults(property.argument, scope, allowedGlobals, diagnostics, offset)
        }
      }
      break
    case 'RestElement':
      visitPatternDefaults(pattern.argument, scope, allowedGlobals, diagnostics, offset)
      break
  }
}

function visitStatements(
  statements: unknown[],
  scope: Scope,
  allowedGlobals: Set<string>,
  diagnostics: BCFDLintDiagnostic[],
  offset: number
) {
  declareBlockNames(statements, scope)
  for (const statement of statements) {
    if (isNode(statement)) {
      visitStatement(statement, scope, allowedGlobals, diagnostics, offset)
    }
  }
}

function visitFunctionBody(
  node: JavaScriptNode,
  parentScope: Scope,
  allowedGlobals: Set<string>,
  diagnostics: BCFDLintDiagnostic[],
  offset: number
) {
  const functionScope = new Scope(parentScope, true)
  if (node.type === 'FunctionExpression' && isNode(node.id)) {
    functionScope.declare(getName(node.id))
  }
  for (const param of getArray(node.params)) {
    declarePattern(param, functionScope)
  }
  for (const param of getArray(node.params)) {
    visitPatternDefaults(param, functionScope, allowedGlobals, diagnostics, offset)
  }
  const body = node.body
  if (isNode(body) && body.type === 'BlockStatement') {
    visitStatements(getArray(body.body), functionScope, allowedGlobals, diagnostics, offset)
  } else {
    visitExpression(body, functionScope, allowedGlobals, diagnostics, offset)
  }
}

function visitClass(
  node: JavaScriptNode,
  scope: Scope,
  allowedGlobals: Set<string>,
  diagnostics: BCFDLintDiagnostic[],
  offset: number
) {
  visitExpression(node.superClass, scope, allowedGlobals, diagnostics, offset)

  const classScope = new Scope(scope)
  if (node.type === 'ClassExpression' && isNode(node.id)) {
    classScope.declare(getName(node.id))
  }

  const body = node.body
  if (!isNode(body)) return

  for (const element of getArray(body.body)) {
    if (!isNode(element)) continue

    if (element.type === 'StaticBlock') {
      visitStatements(
        getArray(element.body),
        new Scope(classScope),
        allowedGlobals,
        diagnostics,
        offset
      )
      continue
    }

    if (element.computed) {
      visitExpression(element.key, classScope, allowedGlobals, diagnostics, offset)
    }
    visitExpression(element.value, classScope, allowedGlobals, diagnostics, offset)
  }
}

function visitStatement(
  node: JavaScriptNode,
  scope: Scope,
  allowedGlobals: Set<string>,
  diagnostics: BCFDLintDiagnostic[],
  offset: number
) {
  switch (node.type) {
    case 'Program':
      visitStatements(getArray(node.body), scope, allowedGlobals, diagnostics, offset)
      break
    case 'BlockStatement':
      visitStatements(getArray(node.body), new Scope(scope), allowedGlobals, diagnostics, offset)
      break
    case 'VariableDeclaration':
      for (const declaration of getArray(node.declarations)) {
        if (isNode(declaration)) {
          declarePattern(declaration.id, node.kind === 'var' ? scope.functionScope : scope)
        }
      }
      for (const declaration of getArray(node.declarations)) {
        if (isNode(declaration)) {
          visitPatternDefaults(declaration.id, scope, allowedGlobals, diagnostics, offset)
          visitExpression(declaration.init, scope, allowedGlobals, diagnostics, offset)
        }
      }
      break
    case 'FunctionDeclaration':
      visitFunctionBody(node, scope, allowedGlobals, diagnostics, offset)
      break
    case 'ClassDeclaration':
      visitClass(node, scope, allowedGlobals, diagnostics, offset)
      break
    case 'ExpressionStatement':
      visitExpression(node.expression, scope, allowedGlobals, diagnostics, offset)
      break
    case 'ReturnStatement':
    case 'ThrowStatement':
      visitExpression(node.argument, scope, allowedGlobals, diagnostics, offset)
      break
    case 'IfStatement':
      visitExpression(node.test, scope, allowedGlobals, diagnostics, offset)
      visitStatementIfPresent(node.consequent, scope, allowedGlobals, diagnostics, offset)
      visitStatementIfPresent(node.alternate, scope, allowedGlobals, diagnostics, offset)
      break
    case 'WhileStatement':
    case 'DoWhileStatement':
      visitExpression(node.test, scope, allowedGlobals, diagnostics, offset)
      visitStatementIfPresent(node.body, scope, allowedGlobals, diagnostics, offset)
      break
    case 'ForStatement': {
      const forScope = new Scope(scope)
      visitStatementIfPresent(node.init, forScope, allowedGlobals, diagnostics, offset)
      visitExpression(node.test, forScope, allowedGlobals, diagnostics, offset)
      visitExpression(node.update, forScope, allowedGlobals, diagnostics, offset)
      visitStatementIfPresent(node.body, forScope, allowedGlobals, diagnostics, offset)
      break
    }
    case 'ForInStatement':
    case 'ForOfStatement': {
      const forScope = new Scope(scope)
      visitStatementIfPresent(node.left, forScope, allowedGlobals, diagnostics, offset)
      visitExpression(node.right, forScope, allowedGlobals, diagnostics, offset)
      visitStatementIfPresent(node.body, forScope, allowedGlobals, diagnostics, offset)
      break
    }
    case 'SwitchStatement':
      visitExpression(node.discriminant, scope, allowedGlobals, diagnostics, offset)
      for (const switchCase of getArray(node.cases)) {
        if (!isNode(switchCase)) continue
        visitExpression(switchCase.test, scope, allowedGlobals, diagnostics, offset)
        visitStatements(
          getArray(switchCase.consequent),
          new Scope(scope),
          allowedGlobals,
          diagnostics,
          offset
        )
      }
      break
    case 'TryStatement':
      visitStatementIfPresent(node.block, scope, allowedGlobals, diagnostics, offset)
      if (isNode(node.handler)) {
        const catchScope = new Scope(scope)
        declarePattern(node.handler.param, catchScope)
        visitPatternDefaults(node.handler.param, catchScope, allowedGlobals, diagnostics, offset)
        visitStatementIfPresent(node.handler.body, catchScope, allowedGlobals, diagnostics, offset)
      }
      visitStatementIfPresent(node.finalizer, scope, allowedGlobals, diagnostics, offset)
      break
    case 'LabeledStatement':
      visitStatementIfPresent(node.body, scope, allowedGlobals, diagnostics, offset)
      break
    case 'WithStatement':
      visitExpression(node.object, scope, allowedGlobals, diagnostics, offset)
      visitStatementIfPresent(node.body, scope, allowedGlobals, diagnostics, offset)
      break
    case 'EmptyStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      break
    default:
      visitExpression(node, scope, allowedGlobals, diagnostics, offset)
  }
}

function visitStatementIfPresent(
  node: unknown,
  scope: Scope,
  allowedGlobals: Set<string>,
  diagnostics: BCFDLintDiagnostic[],
  offset: number
) {
  if (isNode(node)) {
    visitStatement(node, scope, allowedGlobals, diagnostics, offset)
  }
}

function visitExpression(
  node: unknown,
  scope: Scope,
  allowedGlobals: Set<string>,
  diagnostics: BCFDLintDiagnostic[],
  offset: number
) {
  if (!isNode(node)) return

  switch (node.type) {
    case 'Identifier':
      reportRead(node, scope, allowedGlobals, diagnostics, offset)
      break
    case 'Literal':
    case 'ThisExpression':
    case 'Super':
    case 'MetaProperty':
      break
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      visitFunctionBody(node, scope, allowedGlobals, diagnostics, offset)
      break
    case 'ClassExpression':
      visitClass(node, scope, allowedGlobals, diagnostics, offset)
      break
    case 'AssignmentExpression':
      if (isNode(node.left) && node.left.type === 'Identifier') {
        reportRead(node.left, scope, allowedGlobals, diagnostics, offset)
      } else if (
        isNode(node.left) &&
        node.left.type !== 'ObjectPattern' &&
        node.left.type !== 'ArrayPattern'
      ) {
        visitExpression(node.left, scope, allowedGlobals, diagnostics, offset)
      }
      visitExpression(node.right, scope, allowedGlobals, diagnostics, offset)
      break
    case 'UpdateExpression':
      visitExpression(node.argument, scope, allowedGlobals, diagnostics, offset)
      break
    case 'UnaryExpression':
      if (node.operator !== 'typeof') {
        visitExpression(node.argument, scope, allowedGlobals, diagnostics, offset)
      }
      break
    case 'BinaryExpression':
    case 'LogicalExpression':
      visitExpression(node.left, scope, allowedGlobals, diagnostics, offset)
      visitExpression(node.right, scope, allowedGlobals, diagnostics, offset)
      break
    case 'ConditionalExpression':
      visitExpression(node.test, scope, allowedGlobals, diagnostics, offset)
      visitExpression(node.consequent, scope, allowedGlobals, diagnostics, offset)
      visitExpression(node.alternate, scope, allowedGlobals, diagnostics, offset)
      break
    case 'MemberExpression':
      visitExpression(node.object, scope, allowedGlobals, diagnostics, offset)
      if (node.computed) {
        visitExpression(node.property, scope, allowedGlobals, diagnostics, offset)
      }
      break
    case 'CallExpression':
    case 'NewExpression':
      visitExpression(node.callee, scope, allowedGlobals, diagnostics, offset)
      for (const argument of getArray(node.arguments)) {
        visitExpression(argument, scope, allowedGlobals, diagnostics, offset)
      }
      break
    case 'ChainExpression':
      visitExpression(node.expression, scope, allowedGlobals, diagnostics, offset)
      break
    case 'TemplateLiteral':
      for (const expression of getArray(node.expressions)) {
        visitExpression(expression, scope, allowedGlobals, diagnostics, offset)
      }
      break
    case 'TaggedTemplateExpression':
      visitExpression(node.tag, scope, allowedGlobals, diagnostics, offset)
      visitExpression(node.quasi, scope, allowedGlobals, diagnostics, offset)
      break
    case 'ArrayExpression':
      for (const element of getArray(node.elements)) {
        visitExpression(element, scope, allowedGlobals, diagnostics, offset)
      }
      break
    case 'ObjectExpression':
      for (const property of getArray(node.properties)) {
        if (!isNode(property)) continue
        if (property.type === 'SpreadElement') {
          visitExpression(property.argument, scope, allowedGlobals, diagnostics, offset)
        } else {
          if (property.computed) {
            visitExpression(property.key, scope, allowedGlobals, diagnostics, offset)
          }
          visitExpression(property.value, scope, allowedGlobals, diagnostics, offset)
        }
      }
      break
    case 'SpreadElement':
      visitExpression(node.argument, scope, allowedGlobals, diagnostics, offset)
      break
    case 'ObjectPattern':
    case 'ArrayPattern':
      visitPatternDefaults(node, scope, allowedGlobals, diagnostics, offset)
      break
    case 'SequenceExpression':
      for (const expression of getArray(node.expressions)) {
        visitExpression(expression, scope, allowedGlobals, diagnostics, offset)
      }
      break
    case 'AwaitExpression':
    case 'YieldExpression':
      visitExpression(node.argument, scope, allowedGlobals, diagnostics, offset)
      break
    default:
      break
  }
}

function declaredGlobalsFromJavaScript(input: string): Set<string> {
  const globals = new Set<string>()
  if (!input.trim()) return globals

  try {
    const ast = parseJavaScript(sanitizeJavaScriptForParsing(input, 0, input.length))
    if (!ast) return globals

    for (const statement of getArray(ast.body)) {
      if (!isNode(statement)) continue
      if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
        if (isNode(statement.id)) {
          globals.add(getName(statement.id))
        }
      } else if (statement.type === 'VariableDeclaration') {
        for (const declaration of getArray(statement.declarations)) {
          if (!isNode(declaration)) continue
          collectPatternNames(declaration.id, globals)
        }
      }
    }
  } catch {
    return new Set()
  }

  return globals
}

function lintJavaScript(
  input: string,
  start: number,
  end: number,
  diagnostics: BCFDLintDiagnostic[],
  options: BCFDLintOptions
) {
  scanJavaScript(input, start, end, diagnostics)
  if (options.lintJavaScript === false) return

  const source = sanitizeJavaScriptForParsing(input, start, end)
  let ast: JavaScriptNode

  try {
    ast = parseJavaScript(source) as JavaScriptNode
  } catch (error) {
    const position = start + syntaxErrorPosition(error)
    addJavaScriptDiagnostic(
      diagnostics,
      'error',
      `JavaScript syntax error: ${syntaxErrorMessage(error)}`,
      Math.min(position, end),
      1
    )
    return
  }

  const allowedGlobals = new Set([
    ...DEFAULT_JS_GLOBALS,
    ...declaredGlobalsFromJavaScript(options.startupJs ?? ''),
    ...(options.additionalGlobals ?? [])
  ])
  const scope = new Scope()

  visitStatement(ast, scope, allowedGlobals, diagnostics, start)
}

function scanBCFD(
  input: string,
  start: number,
  end: number,
  diagnostics: BCFDLintDiagnostic[],
  options: BCFDLintOptions
) {
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
      lintJavaScript(input, nameEnd, evalEnd, diagnostics, options)
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
    lintJavaScript(input, 0, input.length, diagnostics, options)
  } else {
    scanBCFD(input, 0, input.length, diagnostics, options)
  }

  return diagnostics
}
