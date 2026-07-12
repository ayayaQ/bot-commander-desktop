export type AgentFieldChangeKind = 'added' | 'removed' | 'changed'

export interface AgentFieldChange {
  path: string
  label: string
  before: unknown
  after: unknown
  kind: AgentFieldChangeKind
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function humanize(segment: string): string {
  return segment
    .replace(/~1/g, '/')
    .replace(/~0/g, '~')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase())
}

function labelFor(path: string): string {
  if (!path || path === '/') return 'Content'
  return path.split('/').filter(Boolean).map(humanize).join(' / ')
}

function meaningfulCreationValue(path: string, value: unknown): boolean {
  if (path === '/id') return false
  if (path === '/type') return true
  if (value === null || value === undefined || value === false || value === '') return false
  if (typeof value === 'number') return value !== 0
  if (Array.isArray(value)) return value.some((item, index) => meaningfulCreationValue(`${path}/${index}`, item))
  return true
}

function collectCreated(value: unknown, path: string, changes: AgentFieldChange[]) {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      collectCreated(child, `${path}/${key}`, changes)
    }
    return
  }
  if (!meaningfulCreationValue(path, value)) return
  changes.push({ path: path || '/', label: labelFor(path), before: undefined, after: value, kind: 'added' })
}

function collectDiff(before: unknown, after: unknown, path: string, changes: AgentFieldChange[]) {
  if (equal(before, after)) return
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const key of keys) {
      const nextPath = `${path}/${key}`
      const hasBefore = Object.prototype.hasOwnProperty.call(before, key)
      const hasAfter = Object.prototype.hasOwnProperty.call(after, key)
      if (!hasBefore) collectAdded(after[key], nextPath, changes)
      else if (!hasAfter) collectRemoved(before[key], nextPath, changes)
      else collectDiff(before[key], after[key], nextPath, changes)
    }
    return
  }
  changes.push({ path: path || '/', label: labelFor(path), before, after, kind: 'changed' })
}

function collectAdded(value: unknown, path: string, changes: AgentFieldChange[]) {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) collectAdded(child, `${path}/${key}`, changes)
    return
  }
  changes.push({ path, label: labelFor(path), before: undefined, after: value, kind: 'added' })
}

function collectRemoved(value: unknown, path: string, changes: AgentFieldChange[]) {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) collectRemoved(child, `${path}/${key}`, changes)
    return
  }
  changes.push({ path, label: labelFor(path), before: value, after: undefined, kind: 'removed' })
}

export function diffAgentApproval(before: unknown, after: unknown): AgentFieldChange[] {
  const changes: AgentFieldChange[] = []
  if (before === null || before === undefined) collectCreated(after, '', changes)
  else collectDiff(before, after, '', changes)
  return changes
}
