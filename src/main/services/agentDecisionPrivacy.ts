const knownSecrets = new Set<string>()
let generation = 0
let overflow = false

/** Privileged, process-local comparison only. Never persist or report these values. */
export function registerAgentDecisionSecret(value: unknown): void {
  if (typeof value !== 'string' || !value || knownSecrets.has(value)) return
  if (knownSecrets.size >= 256) {
    overflow = true
    generation++
    return
  }
  knownSecrets.add(value)
  generation++
}

export function agentDecisionPrivacyRevision(): number {
  return generation
}

/** MCP keeps the known-credential registry private and never delegates to the Auto reviewer. */
export function assertAgentMcpPrivacy(value: unknown): void {
  if (overflow) throw new Error('MCP privacy registry is unavailable')
  const decode = (text: string): string[] => {
    const forms = new Set([text])
    let current = text
    for (let pass = 0; pass < 32; pass++) {
      const next = current
        .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
          const bytes = Uint8Array.from(run.match(/%[0-9a-f]{2}/gi) ?? [], (byte) =>
            parseInt(byte.slice(1), 16)
          )
          return new TextDecoder('utf-8').decode(bytes)
        })
      forms.add(next)
      if (next === current) break
      current = next
    }
    return [...forms]
  }
  const secrets = [...knownSecrets].flatMap(decode).filter(Boolean)
  const seen = new Set<object>()
  let nodes = 0
  const visit = (item: unknown): void => {
    if (++nodes > 100_000) throw new Error('MCP privacy check exceeds its limit')
    if (typeof item === 'string') {
      if (decode(item).some((form) => secrets.some((secret) => form.includes(secret))))
        throw new Error('MCP data contains a known credential')
    } else if (item && typeof item === 'object') {
      if (seen.has(item)) throw new Error('MCP privacy check requires acyclic JSON')
      seen.add(item)
      for (const [key, child] of Object.entries(item)) {
        visit(key)
        visit(child)
      }
      seen.delete(item)
    }
  }
  visit(value)
}

function decodedForms(text: string): string[] {
  const forms = new Set([text])
  for (let pass = 0; pass < 3; pass++) {
    for (const value of [...forms]) {
      forms.add(
        value.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      )
      forms.add(
        value.replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      )
      try {
        forms.add(decodeURIComponent(value))
      } catch {}
    }
  }
  return [...forms]
}

// This is a conservative exclusion preflight, not a general sensitive-data classifier.
// Uncertain/flagged content stays local and can still use ordinary manual approval.
const privateContent = [
  /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|authorization|bearer|client[_ -]?secret|private[_ -]?key|social security|ssn|credit card|bank account)\b/i,
  /\b(?:diagnos\w*|medication\w*|prescription\w*|medical|health condition|pregnan\w*|therapy|therapist|depression|suicid\w*|cancer|diabetes|hiv)\b/i,
  /\b(?:creditworthiness|credit score|savings|net worth|assets|account balance|salary|income|debt|minor|child|children|teenager|under[- ]?18)\b/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-or-v1-[A-Za-z0-9_-]+)\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

export function decisionPrivacyReason(value: unknown): string | undefined {
  if (overflow) return 'privacy_registry_unavailable'
  const strings: string[] = []
  const visit = (item: unknown): void => {
    if (typeof item === 'string') strings.push(item)
    else if (Array.isArray(item)) item.forEach(visit)
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        strings.push(key)
        visit(child)
      }
    }
  }
  visit(value)
  for (const text of strings) {
    for (const form of decodedForms(text)) {
      for (const secret of knownSecrets) {
        if (decodedForms(secret).some((candidate) => candidate && form.includes(candidate)))
          return 'privacy_known_secret'
      }
      if (privateContent.some((pattern) => pattern.test(form)))
        return 'privacy_sensitive_or_uncertain'
    }
  }
  return undefined
}
