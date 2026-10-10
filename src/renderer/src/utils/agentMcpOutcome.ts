/** Presentation bound only; outcome authority always comes from the host-owned MCP record. */
export const MCP_RESULT_DISPLAY_LIMIT = 64 * 1024

export function displayAgentMcpResult(result: unknown): { text: string; truncated: boolean } {
  let text: string
  const encoder = new TextEncoder()
  try {
    text = JSON.stringify(result, null, 2) ?? 'No result details available.'
    if (encoder.encode(text).length <= MCP_RESULT_DISPLAY_LIMIT) return { text, truncated: false }
    // Formatting must not clip a legitimate projection admitted within the host's 64 KiB limit.
    text = JSON.stringify(result) ?? 'No result details available.'
  } catch {
    return { text: 'Result details could not be displayed as JSON.', truncated: false }
  }
  const bytes = encoder.encode(text)
  if (bytes.length <= MCP_RESULT_DISPLAY_LIMIT) return { text, truncated: false }
  let end = MCP_RESULT_DISPLAY_LIMIT
  while ((bytes[end] & 0xc0) === 0x80) end--
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    truncated: true
  }
}

export function isAgentMcpErrorResult(result: unknown): boolean {
  return (
    result !== null && typeof result === 'object' && 'success' in result && result.success === false
  )
}
