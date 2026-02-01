/**
 * BCFD Template Language
 *
 * A string interpolation language for Discord bot command responses.
 * Supports variables, functions, nested expressions, and JavaScript evaluation.
 *
 * @example
 * ```typescript
 * import { interpret, BCFDContext } from './bcfdLang'
 *
 * const ctx: BCFDContext = {
 *   user: message.author,
 *   client: client,
 *   // ... other context
 * }
 *
 * const result = await interpret('Hello $name! Random: $random{a|b|c}', ctx)
 * console.log(result.output) // "Hello <@123>! Random: b"
 * ```
 */

export { tokenize, Tokenizer } from './tokenizer'
export { parse, Parser } from './parser'
export { interpret, Interpreter, getInterpreter, formatErrors } from './interpreter'
export type {
  Token,
  TokenType,
  ASTNode,
  NodeType,
  ProgramNode,
  TextNode,
  VariableNode,
  FunctionCallNode,
  EvalBlockNode,
  ErrorNode,
  BCFDContext,
  BCFDFunction,
  BCFDError,
  InterpreterResult,
  FunctionRegistry
} from './types'
