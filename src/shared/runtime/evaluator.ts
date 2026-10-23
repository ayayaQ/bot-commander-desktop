import { IncompleteSimulationError } from './errors'
import { NodeType } from './types'
import type {
  ASTNode,
  BCFDContext,
  BCFDError,
  BCFDFunction,
  ConditionNode,
  FunctionRegistry,
  IfBlockNode,
  InterpreterResult
} from './types'
import { parse } from './parser'
type ScriptErrorDetails = { stack?: string; lineNumber?: number; columnNumber?: number }
export class Interpreter {
  private registry: FunctionRegistry
  private errors: BCFDError[] = []
  private static interpreterCounter = 0

  private visited = 0
  constructor(
    customRegistry: FunctionRegistry,
    private readonly limits?: { nodes: number; output: number; depth: number }
  ) {
    this.registry = customRegistry
  }

  /**
   * Interpret a template string with the given context
   */
  async interpret(input: string, ctx: BCFDContext): Promise<InterpreterResult> {
    this.errors = []
    this.visited = 0

    // Parse the input
    const { ast, errors: parseErrors } = parse(input)
    this.errors.push(...parseErrors)
    if (this.limits) {
      let count = 0
      const inspect = (value: unknown, depth: number) => {
        if (!value || typeof value !== 'object') return
        if (++count > this.limits!.nodes || depth > this.limits!.depth * 4)
          throw new IncompleteSimulationError(
            'Template nesting or work exceeds the playground limit'
          )
        for (const child of Object.values(value)) inspect(child, depth + 1)
      }
      inspect(ast, 0)
    }

    // Evaluate the AST
    const output = await this.evaluateNode(ast, ctx)
    this.addSourceContexts(input)

    return {
      output,
      errors: this.errors
    }
  }

  /**
   * Recursively evaluate an AST node
   */
  private async evaluateNode(node: ASTNode, ctx: BCFDContext): Promise<string> {
    if (this.limits && ++this.visited > this.limits.nodes)
      throw new IncompleteSimulationError('Template work exceeds the playground limit')
    switch (node.type) {
      case NodeType.PROGRAM:
        return this.evaluateProgram(node, ctx)

      case NodeType.TEXT:
        return node.value

      case NodeType.VARIABLE:
        return this.evaluateVariable(node, ctx)

      case NodeType.FUNCTION_CALL:
        return this.evaluateFunctionCall(node, ctx)

      case NodeType.EVAL_BLOCK:
        return this.evaluateEvalBlock(node, ctx)

      case NodeType.IF_BLOCK:
        return this.evaluateIfBlock(node, ctx)

      case NodeType.ERROR:
        return `[BCFD Error: ${node.message}]`

      default:
        return ''
    }
  }

  private async evaluateProgram(
    node: { type: NodeType.PROGRAM; children: ASTNode[] },
    ctx: BCFDContext
  ): Promise<string> {
    const parts: string[] = []
    for (const child of node.children) {
      parts.push(await this.evaluateNode(child, ctx))
    }
    const output = parts.join('')
    if (this.limits && output.length > this.limits.output)
      throw new IncompleteSimulationError('Output exceeds the playground limit')
    return output
  }

  private async evaluateVariable(
    node: { type: NodeType.VARIABLE; name: string; position: number; length: number },
    ctx: BCFDContext
  ): Promise<string> {
    const func = this.registry.get(node.name)
    if (!func) {
      this.addError(`Unknown variable '$${node.name}'`, node.position, node.length)
      return `$${node.name}` // Return original text for unknown variables
    }

    try {
      return await func([], ctx)
    } catch (e) {
      if (e instanceof IncompleteSimulationError) throw e
      const message = e instanceof Error ? e.message : 'Unknown error'
      this.addError(`Error evaluating '$${node.name}': ${message}`, node.position, node.length)
      return `[BCFD Error: ${message}]`
    }
  }

  private async evaluateFunctionCall(
    node: {
      type: NodeType.FUNCTION_CALL
      name: string
      arguments: ASTNode[][]
      syntax: 'paren' | 'brace'
      position: number
      length: number
    },
    ctx: BCFDContext
  ): Promise<string> {
    const func = this.registry.get(node.name)
    if (!func) {
      this.addError(`Unknown function '$${node.name}'`, node.position, node.length)
      // Return original-ish text for unknown functions
      const argStr = node.arguments.map(() => '...').join(node.syntax === 'paren' ? ', ' : '|')
      return node.syntax === 'paren' ? `$${node.name}(${argStr})` : `$${node.name}{${argStr}}`
    }

    // Evaluate all arguments first (recursive!)
    const evaluatedArgs: string[] = []
    for (const argNodes of node.arguments) {
      const parts: string[] = []
      for (const argNode of argNodes) {
        parts.push(await this.evaluateNode(argNode, ctx))
      }
      evaluatedArgs.push(parts.join(''))
    }

    try {
      const result = func(evaluatedArgs, ctx)
      // Handle async functions
      if (result instanceof Promise) {
        return await result
      }
      return result
    } catch (e) {
      if (e instanceof IncompleteSimulationError) throw e
      const message = e instanceof Error ? e.message : 'Unknown error'
      this.addError(`Error evaluating '$${node.name}': ${message}`, node.position, node.length)
      return `[BCFD Error: ${message}]`
    }
  }

  private async evaluateEvalBlock(
    node: {
      type: NodeType.EVAL_BLOCK
      code: string
      codePosition: number
      innerNodes: ASTNode[]
      position: number
      length: number
    },
    ctx: BCFDContext
  ): Promise<string> {
    if (!ctx.vmContext) {
      this.addError('$eval block requires VM context', node.position, node.length)
      return '[BCFD Error: VM context not available]'
    }

    // Security: Store evaluated values in temporary variables to prevent code injection
    // Use unique ID to prevent conflicts between concurrent command executions
    const uniqueId = `${Date.now()}_${Interpreter.interpreterCounter++}`
    let resolvedCode = node.code
    const tempVars: Record<string, string> = {}
    let varCounter = 0

    // Collect replacements to apply (position-based to handle duplicate variable names)
    const replacements: { position: number; length: number; replacement: string }[] = []

    for (const innerNode of node.innerNodes) {
      if (innerNode.type !== NodeType.TEXT) {
        // Skip variables that are inside JavaScript comments or template literal static parts
        if (this.isPositionInJsComment(node.code, innerNode.position)) {
          continue
        }

        // Evaluate the expression to get its value
        const evaluatedValue = await this.evaluateNode(innerNode, ctx)

        // Create a unique temporary variable name with unique ID to prevent race conditions
        const tempVarName = `__bcfd_${uniqueId}_${varCounter++}`

        // Store the value in the VM context
        tempVars[tempVarName] = evaluatedValue
        ctx.vmContext.setVariable(tempVarName, evaluatedValue)

        // Queue the replacement by position (not string matching)
        replacements.push({
          position: innerNode.position,
          length: innerNode.length,
          replacement: tempVarName
        })
      }
    }

    // Sort replacements by position descending so we can apply from end to start
    // This prevents position shifts from affecting subsequent replacements
    replacements.sort((a, b) => b.position - a.position)

    // Apply replacements using position-based slicing
    for (const { position, length, replacement } of replacements) {
      resolvedCode =
        resolvedCode.slice(0, position) + replacement + resolvedCode.slice(position + length)
    }

    try {
      // Execute the JavaScript code with timeout protection.
      const wrapEvalInIIFE = ctx.wrapEvalInIIFE !== false
      const result = ctx.vmContext.evaluate(resolvedCode, {
        timeoutMs: 1000,
        wrapReturn: wrapEvalInIIFE
      })
      return wrapEvalInIIFE && result !== undefined ? String(result) : ''
    } catch (e) {
      if (e instanceof IncompleteSimulationError) throw e
      const jsError = this.describeJavaScriptError(e)
      const position = this.evalErrorPosition(
        node,
        jsError.lineNumber,
        jsError.columnNumber,
        replacements
      )

      this.addError(`JavaScript error: ${jsError.message}`, position, node.length, {
        detail: jsError.detail,
        lineNumber: jsError.lineNumber,
        columnNumber: jsError.columnNumber
      })
      return `[BCFD Error: ${jsError.message}]`
    } finally {
      for (const tempVarName of Object.keys(tempVars)) {
        try {
          ctx.vmContext.deleteVariable(tempVarName)
        } catch (error) {
          if (!this.errors.length) throw error
        }
      }
    }
  }

  private async evaluateIfBlock(node: IfBlockNode, ctx: BCFDContext): Promise<string> {
    for (const branch of node.branches) {
      const condResult = await this.evaluateCondition(branch.condition, ctx)
      if (this.isTruthy(condResult)) {
        const parts: string[] = []
        for (const bodyNode of branch.body) {
          parts.push(await this.evaluateNode(bodyNode, ctx))
        }
        return parts.join('')
      }
    }

    if (node.elseBranch) {
      const parts: string[] = []
      for (const bodyNode of node.elseBranch) {
        parts.push(await this.evaluateNode(bodyNode, ctx))
      }
      return parts.join('')
    }

    return ''
  }

  private async evaluateCondition(node: ConditionNode, ctx: BCFDContext): Promise<string> {
    switch (node.type) {
      case 'value': {
        const parts: string[] = []
        for (const n of node.nodes) {
          parts.push(await this.evaluateNode(n, ctx))
        }
        return parts.join('')
      }
      case 'group':
        return this.evaluateCondition(node.expr, ctx)
      case 'unary': {
        const operand = await this.evaluateCondition(node.operand, ctx)
        return (!this.isTruthy(operand)).toString()
      }
      case 'binary': {
        const left = await this.evaluateCondition(node.left, ctx)
        const right = await this.evaluateCondition(node.right, ctx)
        switch (node.op) {
          case '==':
            return (left === right).toString()
          case '!=':
            return (left !== right).toString()
          case '>': {
            const a = parseFloat(left),
              b = parseFloat(right)
            if (isNaN(a) || isNaN(b)) return 'false'
            return (a > b).toString()
          }
          case '<': {
            const a = parseFloat(left),
              b = parseFloat(right)
            if (isNaN(a) || isNaN(b)) return 'false'
            return (a < b).toString()
          }
          case '>=': {
            const a = parseFloat(left),
              b = parseFloat(right)
            if (isNaN(a) || isNaN(b)) return 'false'
            return (a >= b).toString()
          }
          case '<=': {
            const a = parseFloat(left),
              b = parseFloat(right)
            if (isNaN(a) || isNaN(b)) return 'false'
            return (a <= b).toString()
          }
          case '&':
            return (this.isTruthy(left) && this.isTruthy(right)).toString()
          case '|':
            return (this.isTruthy(left) || this.isTruthy(right)).toString()
          default:
            return 'false'
        }
      }
      default:
        return ''
    }
  }

  private isTruthy(value: string): boolean {
    return value !== '' && value !== 'false' && value !== '0'
  }

  /**
   * Check if a position in JavaScript code is inside a comment or string literal
   * where variables should not be evaluated.
   * - Line comments (//) and block comments: skip
   * - Regular strings ("..." and '...'): skip
   * - Template literals (`...`): skip UNLESS inside an interpolation (${...})
   */
  private isPositionInJsComment(code: string, position: number): boolean {
    let i = 0
    while (i < code.length && i <= position) {
      // Check for regular string literals - variables inside should NOT be evaluated
      if (code[i] === '"' || code[i] === "'") {
        const quote = code[i]
        const stringStart = i
        i++
        while (i < code.length) {
          if (code[i] === '\\' && i + 1 < code.length) {
            i += 2 // Skip escaped character
            continue
          }
          if (code[i] === quote) {
            i++
            break
          }
          i++
        }
        // Check if position is within this string
        if (position >= stringStart && position < i) {
          return true
        }
        continue
      }

      // Check for template literals - more complex handling needed
      if (code[i] === '`') {
        const result = this.checkTemplatePosition(code, i, position)
        if (result.found) {
          return result.shouldSkip
        }
        i = result.endIndex
        continue
      }

      // Check for line comment
      if (code[i] === '/' && i + 1 < code.length && code[i + 1] === '/') {
        const commentStart = i
        // Find end of line
        while (i < code.length && code[i] !== '\n') {
          i++
        }
        // Check if position is within this comment
        if (position >= commentStart && position < i) {
          return true
        }
        continue
      }

      // Check for block comment
      if (code[i] === '/' && i + 1 < code.length && code[i + 1] === '*') {
        const commentStart = i
        i += 2
        // Find end of block comment
        while (i < code.length) {
          if (code[i] === '*' && i + 1 < code.length && code[i + 1] === '/') {
            i += 2
            break
          }
          i++
        }
        // Check if position is within this comment
        if (position >= commentStart && position < i) {
          return true
        }
        continue
      }

      i++
    }

    return false
  }

  /**
   * Check if position is inside a template literal and whether it should be skipped.
   * Variables inside ${...} interpolations should be evaluated.
   * Variables in the static parts of the template should be skipped.
   */
  private checkTemplatePosition(
    code: string,
    startIndex: number,
    position: number
  ): { found: boolean; shouldSkip: boolean; endIndex: number } {
    let i = startIndex + 1 // Skip opening backtick
    const templateStart = startIndex

    while (i < code.length) {
      if (code[i] === '\\' && i + 1 < code.length) {
        i += 2 // Skip escaped character
        continue
      }

      // Check for interpolation start
      if (code[i] === '$' && i + 1 < code.length && code[i + 1] === '{') {
        const interpStart = i
        i += 2 // Skip ${
        let braceDepth = 1

        // Find matching closing brace, handling nested braces and strings
        while (i < code.length && braceDepth > 0) {
          if (code[i] === '\\' && i + 1 < code.length) {
            i += 2
            continue
          }
          if (code[i] === '{') {
            braceDepth++
          } else if (code[i] === '}') {
            braceDepth--
          } else if (code[i] === '"' || code[i] === "'") {
            // Skip nested string inside interpolation
            const quote = code[i]
            i++
            while (i < code.length) {
              if (code[i] === '\\' && i + 1 < code.length) {
                i += 2
                continue
              }
              if (code[i] === quote) {
                break
              }
              i++
            }
          } else if (code[i] === '`') {
            // Handle nested template literal inside interpolation
            const nested = this.checkTemplatePosition(code, i, position)
            if (nested.found) {
              return nested
            }
            i = nested.endIndex
            continue
          }
          i++
        }

        const interpEnd = i
        // Check if position is inside the interpolation (between ${ and })
        // Position inside interpolation should NOT be skipped (should be evaluated)
        if (position >= interpStart + 2 && position < interpEnd - 1) {
          return { found: true, shouldSkip: false, endIndex: i }
        }
        continue
      }

      // End of template literal
      if (code[i] === '`') {
        const templateEnd = i + 1
        // Check if position is in the static part of the template (not in interpolation)
        if (position >= templateStart && position < templateEnd) {
          return { found: true, shouldSkip: true, endIndex: templateEnd }
        }
        return { found: false, shouldSkip: false, endIndex: templateEnd }
      }

      i++
    }

    // Unclosed template literal - treat remainder as template
    if (position >= templateStart) {
      return { found: true, shouldSkip: true, endIndex: i }
    }
    return { found: false, shouldSkip: false, endIndex: i }
  }

  private addError(
    message: string,
    position: number,
    length: number,
    detail?: Pick<BCFDError, 'detail' | 'lineNumber' | 'columnNumber'>
  ): void {
    this.errors.push({ message, position, length, ...detail })
  }

  private addSourceContexts(input: string): void {
    this.errors = this.errors.map((error) => ({
      ...error,
      sourceContext: error.sourceContext ?? sourceContext(input, error.position, error.length)
    }))
  }

  private describeJavaScriptError(error: unknown): {
    message: string
    detail?: string
    lineNumber?: number
    columnNumber?: number
  } {
    if (error instanceof Error && 'details' in error) {
      return {
        message: error.message,
        detail: (error.details as ScriptErrorDetails).stack,
        lineNumber: (error.details as ScriptErrorDetails).lineNumber,
        columnNumber: (error.details as ScriptErrorDetails).columnNumber
      }
    }

    if (error instanceof Error) {
      return {
        message: error.message,
        detail: error.stack
      }
    }

    if (typeof error === 'string') {
      return { message: error }
    }

    if (error && typeof error === 'object') {
      const source = error as Record<string, unknown>
      return {
        message:
          typeof source.message === 'string'
            ? source.message
            : (source.toString?.() ?? JSON.stringify(source)),
        detail: typeof source.stack === 'string' ? source.stack : undefined,
        lineNumber: typeof source.lineNumber === 'number' ? source.lineNumber : undefined,
        columnNumber: typeof source.columnNumber === 'number' ? source.columnNumber : undefined
      }
    }

    return { message: 'Unknown error' }
  }

  private evalErrorPosition(
    node: { code: string; codePosition: number; position: number },
    lineNumber?: number,
    columnNumber?: number,
    replacements: { position: number; length: number; replacement: string }[] = []
  ): number {
    if (lineNumber == null || lineNumber < 1) {
      return node.position
    }

    const lines = node.code.split('\n')
    const lineStart = lines
      .slice(0, lineNumber - 1)
      .reduce((total, line) => total + line.length + 1, 0)
    const columnOffset = columnNumber != null && columnNumber > 0 ? columnNumber - 1 : 0
    const resolvedOffset = lineStart + columnOffset
    const originalOffset = this.originalEvalOffset(resolvedOffset, replacements)

    return node.codePosition + Math.min(originalOffset, node.code.length)
  }

  private originalEvalOffset(
    resolvedOffset: number,
    replacements: { position: number; length: number; replacement: string }[]
  ): number {
    let delta = 0

    for (const replacement of [...replacements].sort((a, b) => a.position - b.position)) {
      const resolvedStart = replacement.position + delta
      const resolvedEnd = resolvedStart + replacement.replacement.length

      if (resolvedOffset < resolvedStart) {
        return Math.max(0, resolvedOffset - delta)
      }

      if (resolvedOffset <= resolvedEnd) {
        return replacement.position
      }

      delta += replacement.replacement.length - replacement.length
    }

    return Math.max(0, resolvedOffset - delta)
  }

  /**
   * Register a custom function
   */
  registerFunction(name: string, fn: BCFDFunction): void {
    this.registry.set(name, fn)
  }
}

export function formatErrors(errors: BCFDError[], input: string): string {
  return errors
    .map((e) => {
      const line = getLineNumber(input, e.position)
      const col = getColumnNumber(input, e.position)
      const jsLocation =
        e.lineNumber != null
          ? ` (JS line ${e.lineNumber}${e.columnNumber != null ? `, column ${e.columnNumber}` : ''})`
          : ''
      const context = e.sourceContext ?? sourceContext(input, e.position, e.length)
      return `Error at line ${line}, column ${col}${jsLocation}: ${e.message}\nNear: ${context}`
    })
    .join('\n')
}

function sourceContext(input: string, position: number, _length: number): string {
  if (!input) return ''

  const safePosition = Math.max(0, Math.min(position, input.length))
  const lineStart = input.lastIndexOf('\n', safePosition - 1) + 1
  const lineEndIndex = input.indexOf('\n', safePosition)
  const lineEnd = lineEndIndex === -1 ? input.length : lineEndIndex
  return input.slice(lineStart, lineEnd)
}

function getLineNumber(input: string, position: number): number {
  return input.slice(0, position).split('\n').length
}

function getColumnNumber(input: string, position: number): number {
  const lastNewline = input.lastIndexOf('\n', position - 1)
  return position - lastNewline
}
