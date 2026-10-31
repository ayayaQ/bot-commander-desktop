const MAX_ERROR_BYTES = 65_536
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Extract only bounded error messages, never raw metadata, echoed input, or headers. */
export async function readOpenRouterDiagnostic(
  response: Response,
  secrets: readonly string[],
  signal?: AbortSignal
): Promise<string | undefined> {
  const reader = response.clone().body?.getReader()
  if (!reader) return undefined
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted) return undefined
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_ERROR_BYTES) return undefined
      chunks.push(value)
    }
    if (signal?.aborted) return undefined
    const data = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const error = record(data?.error) ?? data
    const metadata = record(error?.metadata)
    let upstream: Record<string, unknown> | undefined
    if (typeof metadata?.raw === 'string') {
      try {
        const raw = record(JSON.parse(metadata.raw))
        upstream = record(raw?.error) ?? raw
      } catch {
        /* Non-JSON upstream bodies are not diagnostics. */
      }
    } else {
      const raw = record(metadata?.raw)
      upstream = record(raw?.error) ?? raw
    }
    const clean = (value: unknown): string | undefined => {
      if (typeof value !== 'string' || !value.trim()) return undefined
      let text = value
      for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length))
        text = text.split(secret).join('[redacted]')
      return text
        .replace(/\b(?:sk-[\w-]+|Bearer\s+\S+)/gi, '[redacted]')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 1000)
    }
    const parts = [...new Set([clean(error?.message), clean(upstream?.message)].filter(Boolean))]
    const provider = clean(metadata?.provider_name)
    if (provider) parts.push(`Provider: ${provider.slice(0, 100)}`)
    return parts.length ? parts.join('; ') : undefined
  } catch {
    return undefined
  } finally {
    signal?.removeEventListener('abort', cancel)
    cancel()
  }
}
