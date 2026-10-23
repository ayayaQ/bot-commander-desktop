export interface ScriptExecutionErrorDetails {
  name?: string
  message: string
  stack?: string
  fileName?: string
  lineNumber?: number
  columnNumber?: number
}

export class ScriptExecutionError extends Error {
  constructor(readonly details: ScriptExecutionErrorDetails) {
    super(formatScriptExecutionError(details))
    this.name = details.name ?? 'ScriptExecutionError'
  }
}

function formatScriptExecutionError(details: ScriptExecutionErrorDetails): string {
  const name = details.name && details.name !== 'Error' ? `${details.name}: ` : ''
  const location =
    details.lineNumber != null
      ? ` at line ${details.lineNumber}${
          details.columnNumber != null ? `, column ${details.columnNumber}` : ''
        }`
      : ''

  return `${name}${details.message}${location}`
}
