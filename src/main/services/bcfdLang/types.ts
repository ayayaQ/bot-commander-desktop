/**
 * BCFD Template Language - Types
 *
 * Type definitions for the tokenizer, parser, and interpreter.
 */

// ============================================================================
// Token Types
// ============================================================================

export enum TokenType {
  TEXT = 'TEXT', // Plain text
  DOLLAR = 'DOLLAR', // $ character (start of expression)
  IDENTIFIER = 'IDENTIFIER', // Function/variable name
  LPAREN = 'LPAREN', // (
  RPAREN = 'RPAREN', // )
  LBRACE = 'LBRACE', // {
  RBRACE = 'RBRACE', // }
  COMMA = 'COMMA', // ,
  PIPE = 'PIPE', // |
  EVAL = 'EVAL', // $eval keyword
  HALT = 'HALT', // $halt keyword
  EVAL_CONTENT = 'EVAL_CONTENT', // Content between $eval and $halt
  EOF = 'EOF' // End of input
}

export interface Token {
  type: TokenType
  value: string
  position: number // Start position in source
  length: number // Length of token
}

// ============================================================================
// AST Node Types
// ============================================================================

export enum NodeType {
  PROGRAM = 'PROGRAM', // Root node containing a list of nodes
  TEXT = 'TEXT', // Plain text literal
  VARIABLE = 'VARIABLE', // $variableName (no arguments)
  FUNCTION_CALL = 'FUNCTION_CALL', // $functionName(...) or $functionName{...}
  EVAL_BLOCK = 'EVAL_BLOCK', // $eval ... $halt
  ERROR = 'ERROR' // Error placeholder
}

export interface BaseNode {
  type: NodeType
  position: number // Start position in source
  length: number // Length in source
}

export interface ProgramNode extends BaseNode {
  type: NodeType.PROGRAM
  children: ASTNode[]
}

export interface TextNode extends BaseNode {
  type: NodeType.TEXT
  value: string
}

export interface VariableNode extends BaseNode {
  type: NodeType.VARIABLE
  name: string
}

export interface FunctionCallNode extends BaseNode {
  type: NodeType.FUNCTION_CALL
  name: string
  arguments: ASTNode[][] // Each argument can be a sequence of nodes (for interpolation)
  syntax: 'paren' | 'brace' // Which syntax was used
}

export interface EvalBlockNode extends BaseNode {
  type: NodeType.EVAL_BLOCK
  code: string // Raw JavaScript code (with $expressions already resolved)
  innerNodes: ASTNode[] // Parsed nodes within the eval block for pre-resolution
}

export interface ErrorNode extends BaseNode {
  type: NodeType.ERROR
  message: string
  originalText: string
}

export type ASTNode =
  | ProgramNode
  | TextNode
  | VariableNode
  | FunctionCallNode
  | EvalBlockNode
  | ErrorNode

// ============================================================================
// Interpreter Types
// ============================================================================

export interface BCFDError {
  message: string
  position: number
  length: number
}

export interface InterpreterResult {
  output: string
  errors: BCFDError[]
}

// Function signature for built-in functions
// Can return string directly or Promise<string> for async functions
export type BCFDFunction = (args: string[], ctx: BCFDContext) => string | Promise<string>

// Context passed to all functions during evaluation
export interface BCFDContext {
  // Discord context
  user?: import('discord.js').User
  member?: import('discord.js').GuildMember
  client?: import('discord.js').Client
  guild?: import('discord.js').Guild
  textChannel?: import('discord.js').TextChannel
  mentionedUser?: import('discord.js').User
  messageEvent?:
    | import('discord.js').OmitPartialGroupDMChannel<import('discord.js').Message<boolean>>
    | import('discord.js').Message<boolean>
  command?: import('../../types/types').BCFDCommand

  // VM context for $eval blocks
  vmContext?: import('vm').Context

  // Settings
  useLegacyMode?: boolean
}

// Registry of all available functions
export type FunctionRegistry = Map<string, BCFDFunction>
