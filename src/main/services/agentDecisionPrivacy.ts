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
