/**
 * BCFD Template Language - Parser
 *
 * Parses tokens into an Abstract Syntax Tree (AST).
 * Handles nested expressions recursively.
 */

import { tokenize } from './tokenizer'
import {
  ASTNode,
  BCFDError,
  EvalBlockNode,
  NodeType,
  ProgramNode,
  TextNode,
  Token,
  TokenType
} from './types'

export class Parser {
  private tokens: Token[] = []
  private position: number = 0
  private errors: BCFDError[] = []

  constructor() {}

  /**
   * Parse an input string into an AST
   */
  parse(input: string): { ast: ProgramNode; errors: BCFDError[] } {
    this.tokens = tokenize(input)
    this.position = 0
    this.errors = []

    const children: ASTNode[] = []

    while (!this.isAtEnd()) {
      const node = this.parseNode()
      if (node) {
        children.push(node)
      }
    }

    const ast: ProgramNode = {
      type: NodeType.PROGRAM,
      children,
      position: 0,
      length: input.length
    }

    return { ast, errors: this.errors }
  }

  private parseNode(): ASTNode | null {
    const token = this.current()

    if (!token || token.type === TokenType.EOF) {
      return null
    }

    switch (token.type) {
      case TokenType.TEXT:
        return this.parseText()

      case TokenType.IDENTIFIER:
        return this.parseExpression()

      case TokenType.EVAL:
        return this.parseEvalBlock()

      default:
        // Unknown token, consume and return as text
        this.advance()
        return {
          type: NodeType.TEXT,
          value: token.value,
          position: token.position,
          length: token.length
        }
    }
  }

  private parseText(): TextNode {
    const token = this.advance()!
    return {
      type: NodeType.TEXT,
      value: token.value,
      position: token.position,
      length: token.length
    }
  }

  private parseExpression(): ASTNode {
    const token = this.advance()!
    const value = token.value

    // Check if it's a function call with parens
    const parenMatch = value.match(/^(\w+)\((.*)?\)$/s)
    if (parenMatch) {
      const [, name, argsStr] = parenMatch
      const args = this.parseParenArguments(argsStr || '', token.position + name.length + 2)
      return {
        type: NodeType.FUNCTION_CALL,
        name,
        arguments: args,
        syntax: 'paren',
        position: token.position,
        length: token.length
      }
    }

    // Check if it's a function call with braces
    const braceMatch = value.match(/^(\w+)\{(.*)?\}$/s)
    if (braceMatch) {
      const [, name, argsStr] = braceMatch
      const args = this.parseBraceArguments(argsStr || '', token.position + name.length + 2)
      return {
        type: NodeType.FUNCTION_CALL,
        name,
        arguments: args,
        syntax: 'brace',
        position: token.position,
        length: token.length
      }
    }

    // Simple variable
    return {
      type: NodeType.VARIABLE,
      name: value,
      position: token.position,
      length: token.length
    }
  }

  /**
   * Parse comma-separated arguments within parentheses
   * Each argument can contain nested expressions
   */
  private parseParenArguments(argsStr: string, basePosition: number): ASTNode[][] {
    if (argsStr.trim() === '') {
      return []
    }

    const args: ASTNode[][] = []
    let currentArg = ''
    let depth = 0
    let pos = 0

    for (let i = 0; i < argsStr.length; i++) {
      const char = argsStr[i]

      // Handle escape sequences
      if (char === '\\' && i + 1 < argsStr.length) {
        currentArg += argsStr[i + 1]
        i++
        continue
      }

      // Track nested parens/braces
      if (char === '(' || char === '{') {
        depth++
        currentArg += char
      } else if (char === ')' || char === '}') {
        depth--
        currentArg += char
      } else if (char === ',' && depth === 0) {
        // Argument separator at top level
        args.push(this.parseArgumentContent(currentArg.trim(), basePosition + pos))
        currentArg = ''
        pos = i + 1
      } else {
        currentArg += char
      }
    }

    // Don't forget the last argument
    if (currentArg.trim() !== '') {
      args.push(this.parseArgumentContent(currentArg.trim(), basePosition + pos))
    }

    return args
  }

  /**
   * Parse pipe-separated arguments within braces
   * Each argument can contain nested expressions
   */
  private parseBraceArguments(argsStr: string, basePosition: number): ASTNode[][] {
    if (argsStr.trim() === '') {
      return []
    }

    const args: ASTNode[][] = []
    let currentArg = ''
    let depth = 0
    let pos = 0

    for (let i = 0; i < argsStr.length; i++) {
      const char = argsStr[i]

      // Handle escape sequences
      if (char === '\\' && i + 1 < argsStr.length) {
        currentArg += argsStr[i + 1]
        i++
        continue
      }

      // Track nested parens/braces
      if (char === '(' || char === '{') {
        depth++
        currentArg += char
      } else if (char === ')' || char === '}') {
        depth--
        currentArg += char
      } else if (char === '|' && depth === 0) {
        // Argument separator at top level
        args.push(this.parseArgumentContent(currentArg, basePosition + pos))
        currentArg = ''
        pos = i + 1
      } else {
        currentArg += char
      }
    }

    // Don't forget the last argument
    if (currentArg !== '') {
      args.push(this.parseArgumentContent(currentArg, basePosition + pos))
    }

    return args
  }

  /**
   * Recursively parse the content of an argument
   * Arguments can contain text and nested $expressions
   */
  private parseArgumentContent(content: string, basePosition: number): ASTNode[] {
    // Recursively parse the argument content
    const subParser = new Parser()
    const { ast, errors } = subParser.parse(content)

    // Adjust positions to be relative to the original input
    this.adjustPositions(ast.children, basePosition)

    // Collect any errors from sub-parsing
    for (const error of errors) {
      this.errors.push({
        ...error,
        position: error.position + basePosition
      })
    }

    return ast.children
  }

  /**
   * Adjust positions of nodes to account for their location in the original input
   */
  private adjustPositions(nodes: ASTNode[], offset: number): void {
    for (const node of nodes) {
      node.position += offset

      if (node.type === NodeType.FUNCTION_CALL) {
        for (const arg of node.arguments) {
          this.adjustPositions(arg, 0) // Already adjusted in parseArgumentContent
        }
      } else if (node.type === NodeType.EVAL_BLOCK) {
        this.adjustPositions(node.innerNodes, 0)
      }
    }
  }

  private parseEvalBlock(): EvalBlockNode {
    const token = this.advance()!

    // Parse any $expressions within the eval block for pre-resolution
    const subParser = new Parser()
    const { ast: innerAst, errors: innerErrors } = subParser.parse(token.value)

    // Collect errors
    for (const error of innerErrors) {
      this.errors.push({
        ...error,
        position: error.position + token.position + 5 // +5 for "$eval"
      })
    }

    return {
      type: NodeType.EVAL_BLOCK,
      code: token.value,
      innerNodes: innerAst.children,
      position: token.position,
      length: token.length
    }
  }

  private current(): Token | undefined {
    return this.tokens[this.position]
  }

  private advance(): Token | undefined {
    const token = this.current()
    this.position++
    return token
  }

  private isAtEnd(): boolean {
    const current = this.current()
    return !current || current.type === TokenType.EOF
  }
}

/**
 * Convenience function to parse a string
 */
export function parse(input: string): { ast: ProgramNode; errors: BCFDError[] } {
  const parser = new Parser()
  return parser.parse(input)
}
