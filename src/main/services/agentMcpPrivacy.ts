// SPDX-License-Identifier: Apache-2.0
// Host-owned bounded credential exclusion. Never log, persist or advertise matching values.
export function environmentSecrets(env: Readonly<NodeJS.ProcessEnv>): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    /(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)$/i.test(name) && value ? [value] : []
  )
}
export function mcpContainsSecret(value: unknown, secrets: readonly string[]): boolean {
  if (!secrets.some((secret) => secret)) return false
  const pending = [value],
    seen = new WeakSet<object>(),
    decoder = new TextDecoder()
  let nodes = 0
  while (pending.length) {
    if (++nodes > 8 * 1024 * 1024) return true
    const item = pending.pop()
    if (typeof item === 'string') {
      let decoded = item
      for (let pass = 0; pass < 32; pass++) {
        if (secrets.some((secret) => secret && decoded.includes(secret))) return true
        const next = decoded
          .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/(?:%[\da-f]{2})+/gi, (run) =>
            decoder.decode(
              Uint8Array.from(run.match(/%[\da-f]{2}/gi)!, (byte) => parseInt(byte.slice(1), 16))
            )
          )
        if (next === decoded) break
        decoded = next
      }
      // Also check the result of the final permitted decoding pass.
      if (secrets.some((secret) => secret && decoded.includes(secret))) return true
    } else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item)
      if (Array.isArray(item)) for (const child of item) pending.push(child)
      else for (const [key, child] of Object.entries(item)) pending.push(key, child)
    }
  }
  return false
}
