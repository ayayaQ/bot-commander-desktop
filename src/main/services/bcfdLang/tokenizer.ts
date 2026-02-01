/**
 * BCFD Template Language - Tokenizer
 *
 * Converts input string into a stream of tokens for the parser.
 */

import { Token, TokenType } from './types'

export class Tokenizer {
  private input: string
  private position: number = 0
  private tokens: Token[] = []

  constructor(input: string) {
    this.input = input
  }

  /**
   * Tokenize the entire input string
   */
  tokenize(): Token[] {
    this.tokens = []
    this.position = 0

    while (this.position < this.input.length) {
      const token = this.nextToken()
      if (token) {
        this.tokens.push(token)
      }
    }

    this.tokens.push({
      type: TokenType.EOF,
      value: '',
      position: this.position,
      length: 0
    })

    return this.tokens
  }

  private nextToken(): Token | null {
    if (this.position >= this.input.length) {
      return null
    }

    const char = this.input[this.position]

    // Check for escape sequence $$
    if (char === '$' && this.peek(1) === '$') {
      const pos = this.position
      this.position += 2
      return { type: TokenType.TEXT, value: '$', position: pos, length: 2 }
    }

    // Check for $ (start of expression)
    if (char === '$') {
      return this.tokenizeDollarExpression()
    }

    // Otherwise, consume as text until we hit a $ or end
    return this.tokenizeText()
  }

  private tokenizeDollarExpression(): Token {
    const startPos = this.position
    this.position++ // consume $

    // Check for $eval
    if (this.matchKeyword('eval')) {
      this.position += 4 // consume 'eval'

      // Find $halt
      const haltIndex = this.input.indexOf('$halt', this.position)
      if (haltIndex === -1) {
        // No $halt found - return error as text
        return {
          type: TokenType.TEXT,
          value: this.input.slice(startPos),
          position: startPos,
          length: this.input.length - startPos
        }
      }

      // Extract content between $eval and $halt
      const content = this.input.slice(this.position, haltIndex)
      this.position = haltIndex + 5 // skip past $halt

      return {
        type: TokenType.EVAL,
        value: content.trim(),
        position: startPos,
        length: this.position - startPos
      }
    }

    // Read identifier
    const identStart = this.position
    while (this.position < this.input.length && this.isIdentifierChar(this.input[this.position])) {
      this.position++
    }

    const identifier = this.input.slice(identStart, this.position)

    if (identifier.length === 0) {
      // Bare $ followed by non-identifier
      return { type: TokenType.TEXT, value: '$', position: startPos, length: 1 }
    }

    // Check what follows the identifier
    const nextChar = this.input[this.position]

    if (nextChar === '(') {
      // Function call with parentheses
      return this.tokenizeParenFunction(startPos, identifier)
    } else if (nextChar === '{') {
      // Function call with braces
      return this.tokenizeBraceFunction(startPos, identifier)
    } else {
      // Simple variable
      return {
        type: TokenType.IDENTIFIER,
        value: identifier,
        position: startPos,
        length: this.position - startPos
      }
    }
  }

  private tokenizeParenFunction(startPos: number, name: string): Token {
    // We're at the opening (
    let depth = 0
    let args = ''

    while (this.position < this.input.length) {
      const char = this.input[this.position]

      if (char === '\\' && this.position + 1 < this.input.length) {
        // Escape sequence - include both characters
        args += char + this.input[this.position + 1]
        this.position += 2
        continue
      }

      if (char === '(') {
        depth++
      } else if (char === ')') {
        depth--
        if (depth === 0) {
          this.position++ // consume closing )
          break
        }
      }

      args += char
      this.position++
    }

    return {
      type: TokenType.IDENTIFIER,
      value: `${name}(${args.slice(1)})`, // Include full function call
      position: startPos,
      length: this.position - startPos
    }
  }

  private tokenizeBraceFunction(startPos: number, name: string): Token {
    // We're at the opening {
    let depth = 0
    let args = ''

    while (this.position < this.input.length) {
      const char = this.input[this.position]

      if (char === '\\' && this.position + 1 < this.input.length) {
        // Escape sequence - include both characters
        args += char + this.input[this.position + 1]
        this.position += 2
        continue
      }

      if (char === '{') {
        depth++
      } else if (char === '}') {
        depth--
        if (depth === 0) {
          this.position++ // consume closing }
          break
        }
      }

      args += char
      this.position++
    }

    return {
      type: TokenType.IDENTIFIER,
      value: `${name}${args}}`, // Include full function call with braces
      position: startPos,
      length: this.position - startPos
    }
  }

  private tokenizeText(): Token {
    const startPos = this.position
    let text = ''

    while (this.position < this.input.length) {
      const char = this.input[this.position]

      // Stop at $ (start of potential expression)
      if (char === '$') {
        break
      }

      text += char
      this.position++
    }

    return {
      type: TokenType.TEXT,
      value: text,
      position: startPos,
      length: text.length
    }
  }

  private matchKeyword(keyword: string): boolean {
    return this.input.slice(this.position, this.position + keyword.length) === keyword
  }

  private peek(offset: number = 0): string | undefined {
    return this.input[this.position + offset]
  }

  private isIdentifierChar(char: string): boolean {
    return /[a-zA-Z0-9_]/.test(char)
  }
}

/**
 * Convenience function to tokenize a string
 */
export function tokenize(input: string): Token[] {
  const tokenizer = new Tokenizer(input)
  return tokenizer.tokenize()
}
