import type { BCFDContext } from './types'

/** Explicit host capabilities. The evaluator never loads services or credentials. */
export interface RuntimeServices {
  maxOutput?: number
  now(): number
  random(): number
  commandCount(): number
  chat(prompt: string): Promise<string>
  setStatus(context: BCFDContext, args: string[]): string
  mutualGuildCount(context: BCFDContext, user: BCFDContext['user']): string
  deleteMessage(args: string[], context: BCFDContext): string | Promise<string>
  cooldownRemaining(
    id: string,
    level: 'user' | 'server' | 'global',
    seconds: number,
    scope?: string
  ): number
}
