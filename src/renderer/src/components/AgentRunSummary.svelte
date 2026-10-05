<script lang="ts">
  import type { AgentRunMetrics } from '../../../shared/agentTypes'
  import {
    agentRunElapsed,
    agentRunOutcome,
    agentRunToolSummary,
    agentRunValidationSummary,
    formatAgentTokenCount
  } from '../../../shared/agentRunMetrics'

  let { metrics }: { metrics: AgentRunMetrics } = $props()
</script>

<details class="border border-base-300 rounded-md bg-base-200 text-xs">
  <summary class="px-3 py-2 cursor-pointer font-medium">Run summary</summary>
  <div class="px-3 pb-3 space-y-2" aria-label="Agent run summary">
    <dl class="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 tabular-nums">
      <div>
        <dt class="opacity-60">Outcome</dt>
        <dd>{agentRunOutcome(metrics)}</dd>
      </div>
      <div>
        <dt class="opacity-60">Recorded elapsed</dt>
        <dd>{agentRunElapsed(metrics)}</dd>
      </div>
      <div>
        <dt class="opacity-60">Recorded rounds</dt>
        <dd>{formatAgentTokenCount(metrics.providerRounds)}</dd>
      </div>
      <div>
        <dt class="opacity-60">Recorded total tokens</dt>
        <dd>{formatAgentTokenCount(metrics.totalTokens)}</dd>
      </div>
      <div>
        <dt class="opacity-60">Recorded input tokens</dt>
        <dd>{formatAgentTokenCount(metrics.inputTokens)}</dd>
      </div>
      <div>
        <dt class="opacity-60">Recorded output tokens</dt>
        <dd>{formatAgentTokenCount(metrics.outputTokens)}</dd>
      </div>
      <div>
        <dt class="opacity-60">Cache read</dt>
        <dd>{formatAgentTokenCount(metrics.cachedInputTokens)}</dd>
      </div>
      <div>
        <dt class="opacity-60">Cache write</dt>
        <dd>{formatAgentTokenCount(metrics.cacheWriteInputTokens)}</dd>
      </div>
    </dl>
    <p>Recorded tools: {agentRunToolSummary(metrics)}</p>
    <p>Validation: {agentRunValidationSummary(metrics)}</p>
    <p class="opacity-60">
      Token totals may omit unreported usage; zero is not proof of no usage. Cache counts are
      included in input tokens. Unreported cache counts are unavailable.
      {#if metrics.usageReconciled === false}
        Partial checkpoint: usage from a round still executing tools or a provider request in flight
        is unavailable.
      {/if}
      {#if metrics.status === 'interrupted'}
        Elapsed time ends at the last recorded checkpoint; the closure time and unfinished tool
        outcomes are unknown.
      {:else if metrics.status === 'running'}
        Elapsed time is through the latest recorded checkpoint.
      {/if}
    </p>
  </div>
</details>
