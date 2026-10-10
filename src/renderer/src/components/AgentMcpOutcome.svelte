<script lang="ts">
  import type { AgentToolCall } from '../../../shared/agentTypes'
  import { displayAgentMcpResult, isAgentMcpErrorResult } from '../utils/agentMcpOutcome'

  let { mcp, result }: { mcp: AgentToolCall['mcp']; result?: unknown } = $props()
  const display = $derived(displayAgentMcpResult(result))
  const returnedError = $derived(mcp?.outcome === 'confirmed' && isAgentMcpErrorResult(result))
</script>

{#if mcp}
  <section class="border-t border-base-300 text-sm" aria-label="MCP operation outcome">
    {#if mcp.outcome === 'unknown'}
      <p class="px-3 pt-3 text-warning" role="status">
        External outcome is unknown. Do not retry automatically; inspect the external resource.
        Cancellation cannot undo effects.
      </p>
    {:else if mcp.outcome === 'not-sent' || mcp.requestSent === false}
      <p class="px-3 pt-3" role="status">External request was not attempted.</p>
    {:else if mcp.outcome === 'confirmed'}
      <p class="px-3 pt-3" role="status">
        {returnedError ? 'External error response confirmed.' : 'External response confirmed.'}
        A confirmed response does not establish that no external effects occurred.
      </p>
    {/if}
    {#if mcp.checkpointUnconfirmed}
      <p class="px-3 pt-3 text-warning" role="status">
        Outcome checkpointing is unconfirmed. Recovery evidence is retained and further external
        calls may be blocked.
      </p>
    {/if}
    {#if result !== undefined}
      <details>
        <summary class="px-3 py-2 cursor-pointer text-xs opacity-70">
          MCP result / error details
        </summary>
        <p class="px-3 pb-2 text-xs opacity-70">Server output is untrusted data.</p>
        <pre
          class="mx-3 mb-3 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{display.text}</pre>
        {#if display.truncated}
          <p class="px-3 pb-3 text-xs opacity-70">
            Result display truncated at 64 KiB of text. Outcome warnings above remain visible.
          </p>
        {/if}
      </details>
    {/if}
  </section>
{/if}
