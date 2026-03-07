/**
 * BCFD Template Language - Condition Expression Parser
 *
 * Parses condition expressions used in $if/$elseif blocks.
 * Supports operators: ==, !=, >, <, >=, <=, & (AND), | (OR), ! (NOT), () (grouping)
 *
 * Grammar (precedence low to high):
 *   expression → or_expr
 *   or_expr    → and_expr (('||' | '|') and_expr)*
 *   and_expr   → equality (('&&' | '&') equality)*
 *   equality   → comparison (('==' | '!=') comparison)?
 *   comparison → unary (('>' | '<' | '>=' | '<=') unary)?
 *   unary      → '!' unary | primary
 *   primary    → '(' expression ')' | value
 *   value      → bcfd_expression | literal_text
 */

import { parse as bcfdParse } from './parser'
import {
  ASTNode,
  BCFDError,
  ConditionBinaryNode,
  ConditionNode,
  ConditionValueNode
} from './types'

// ============================================================================
// Condition Token Types
// ============================================================================

type CondTokenType = 'OP' | 'LPAREN' | 'RPAREN' | 'VALUE' | 'EOF'

interface CondToken {
  type: CondTokenType
  value: string
  position: number
}

// ============================================================================
// Condition Tokenizer
// ============================================================================

function tokenizeCondition(input: string, basePosition: number): CondToken[] {
  const tokens: CondToken[] = []
  let i = 0

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) {
      i++
      continue
    }

    const pos = basePosition + i

    // Multi-char operators (check before single-char)
    if (input[i] === '=' && input[i + 1] === '=') {
      tokens.push({ type: 'OP', value: '==', position: pos })
      i += 2
      continue
    }
    if (input[i] === '!' && input[i + 1] === '=') {
      tokens.push({ type: 'OP', value: '!=', position: pos })
      i += 2
      continue
    }
    if (input[i] === '>' && input[i + 1] === '=') {
      tokens.push({ type: 'OP', value: '>=', position: pos })
      i += 2
      continue
    }
    if (input[i] === '<' && input[i + 1] === '=') {
      tokens.push({ type: 'OP', value: '<=', position: pos })
      i += 2
      continue
    }
    if (input[i] === '&' && input[i + 1] === '&') {
      tokens.push({ type: 'OP', value: '&', position: pos })
      i += 2
      continue
    }
    if (input[i] === '|' && input[i + 1] === '|') {
      tokens.push({ type: 'OP', value: '|', position: pos })
      i += 2
      continue
    }

    // Single-char operators
    if (input[i] === '>' || input[i] === '<') {
      tokens.push({ type: 'OP', value: input[i], position: pos })
      i++
      continue
    }
    if (input[i] === '&') {
      tokens.push({ type: 'OP', value: '&', position: pos })
      i++
      continue
    }
    if (input[i] === '|') {
      tokens.push({ type: 'OP', value: '|', position: pos })
      i++
      continue
    }
    if (input[i] === '!') {
      tokens.push({ type: 'OP', value: '!', position: pos })
      i++
      continue
    }

    // Grouping parens (NOT preceded by $identifier — that's handled as bcfd expression)
    if (input[i] === '(') {
      tokens.push({ type: 'LPAREN', value: '(', position: pos })
      i++
      continue
    }
    if (input[i] === ')') {
      tokens.push({ type: 'RPAREN', value: ')', position: pos })
      i++
      continue
    }

    // bcfd expression: $identifier, $identifier(...), $identifier{...}
    if (input[i] === '$') {
      const start = i
      i++ // skip $

      // Check for $$ escape
      if (i < input.length && input[i] === '$') {
        i++
        tokens.push({ type: 'VALUE', value: '$$', position: pos })
        continue
      }

      // Read identifier
      let ident = ''
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
        ident += input[i]
        i++
      }

      if (ident.length === 0) {
        // Bare $ — treat as literal
        tokens.push({ type: 'VALUE', value: '$', position: pos })
        continue
      }

      // Check for function call with parens
      if (i < input.length && input[i] === '(') {
        let depth = 0
        while (i < input.length) {
          if (input[i] === '\\' && i + 1 < input.length) {
            i += 2
            continue
          }
          if (input[i] === '(') depth++
          else if (input[i] === ')') {
            depth--
            if (depth === 0) {
              i++ // consume closing )
              break
            }
          }
          i++
        }
        tokens.push({
          type: 'VALUE',
          value: input.slice(start, i),
          position: pos
        })
        continue
      }

      // Check for function call with braces
      if (i < input.length && input[i] === '{') {
        let depth = 0
        while (i < input.length) {
          if (input[i] === '\\' && i + 1 < input.length) {
            i += 2
            continue
          }
          if (input[i] === '{') depth++
          else if (input[i] === '}') {
            depth--
            if (depth === 0) {
              i++ // consume closing }
              break
            }
          }
          i++
        }
        tokens.push({
          type: 'VALUE',
          value: input.slice(start, i),
          position: pos
        })
        continue
      }

      // Simple variable
      tokens.push({ type: 'VALUE', value: '$' + ident, position: pos })
      continue
    }

    // Literal text: everything until next operator, paren, $, or end
    const start = i
    while (i < input.length) {
      const ch = input[i]
      if (
        ch === '$' ||
        ch === '(' ||
        ch === ')' ||
        ch === '!' ||
        ch === '=' ||
        ch === '>' ||
        ch === '<' ||
        ch === '&' ||
        ch === '|'
      ) {
        break
      }
      i++
    }
    const literal = input.slice(start, i).trim()
    if (literal.length > 0) {
      tokens.push({ type: 'VALUE', value: literal, position: pos })
    }
  }

  tokens.push({ type: 'EOF', value: '', position: basePosition + input.length })
  return tokens
}

// ============================================================================
// Condition Parser (Recursive Descent)
// ============================================================================

class ConditionParserImpl {
  private tokens: CondToken[]
  private pos: number = 0
  private errors: BCFDError[] = []

  constructor(tokens: CondToken[]) {
    this.tokens = tokens
  }

  parse(): { condition: ConditionNode; errors: BCFDError[] } {
    const condition = this.parseOrExpr()
    if (this.current().type !== 'EOF') {
      this.errors.push({
        message: 'Unexpected token in condition',
        position: this.current().position,
        length: this.current().value.length
      })
    }
    return { condition, errors: this.errors }
  }

  private parseOrExpr(): ConditionNode {
    let left = this.parseAndExpr()
    while (this.current().type === 'OP' && this.current().value === '|') {
      this.advance()
      const right = this.parseAndExpr()
      left = { type: 'binary', op: '|', left, right }
    }
    return left
  }

  private parseAndExpr(): ConditionNode {
    let left = this.parseEquality()
    while (this.current().type === 'OP' && this.current().value === '&') {
      this.advance()
      const right = this.parseEquality()
      left = { type: 'binary', op: '&', left, right }
    }
    return left
  }

  private parseEquality(): ConditionNode {
    let left = this.parseComparison()
    const op = this.current()
    if (op.type === 'OP' && (op.value === '==' || op.value === '!=')) {
      this.advance()
      const right = this.parseComparison()
      left = { type: 'binary', op: op.value as ConditionBinaryNode['op'], left, right }
    }
    return left
  }

  private parseComparison(): ConditionNode {
    let left = this.parseUnary()
    const op = this.current()
    if (
      op.type === 'OP' &&
      (op.value === '>' || op.value === '<' || op.value === '>=' || op.value === '<=')
    ) {
      this.advance()
      const right = this.parseUnary()
      left = { type: 'binary', op: op.value as ConditionBinaryNode['op'], left, right }
    }
    return left
  }

  private parseUnary(): ConditionNode {
    if (this.current().type === 'OP' && this.current().value === '!') {
      this.advance()
      const operand = this.parseUnary()
      return { type: 'unary', op: '!', operand }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): ConditionNode {
    // Grouped expression
    if (this.current().type === 'LPAREN') {
      this.advance() // consume (
      const expr = this.parseOrExpr()
      if (this.current().type === 'RPAREN') {
        this.advance() // consume )
      } else {
        this.errors.push({
          message: 'Missing closing ) in condition',
          position: this.current().position,
          length: 1
        })
      }
      return { type: 'group', expr }
    }

    // Value (bcfd expression or literal)
    if (this.current().type === 'VALUE') {
      const token = this.advance()
      return this.parseValueToConditionNode(token.value, token.position)
    }

    // Unexpected token — create an empty value node and report error
    this.errors.push({
      message: `Unexpected '${this.current().value}' in condition`,
      position: this.current().position,
      length: this.current().value.length || 1
    })
    this.advance()
    return { type: 'value', nodes: [] }
  }

  private parseValueToConditionNode(raw: string, position: number): ConditionValueNode {
    // Parse the raw value through the bcfd parser to resolve $expressions
    const { ast, errors } = bcfdParse(raw)

    // Adjust positions relative to the original input
    for (const node of ast.children) {
      this.adjustNodePositions(node, position)
    }
    for (const error of errors) {
      this.errors.push({
        ...error,
        position: error.position + position
      })
    }

    return { type: 'value', nodes: ast.children }
  }

  private adjustNodePositions(node: ASTNode, offset: number): void {
    node.position += offset
    if (node.type === 'FUNCTION_CALL') {
      for (const arg of node.arguments) {
        for (const n of arg) {
          this.adjustNodePositions(n, 0)
        }
      }
    }
  }

  private current(): CondToken {
    return this.tokens[this.pos] ?? { type: 'EOF' as const, value: '', position: 0 }
  }

  private advance(): CondToken {
    const token = this.current()
    this.pos++
    return token
  }
}

// ============================================================================
// Public API
// ============================================================================

export function parseCondition(
  conditionStr: string,
  basePosition: number
): { condition: ConditionNode; errors: BCFDError[] } {
  if (conditionStr.trim() === '') {
    return {
      condition: { type: 'value', nodes: [] },
      errors: [{ message: 'Empty condition in $if', position: basePosition, length: 0 }]
    }
  }

  const tokens = tokenizeCondition(conditionStr, basePosition)
  const parser = new ConditionParserImpl(tokens)
  return parser.parse()
}
