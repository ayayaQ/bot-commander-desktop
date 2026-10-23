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
  let dialog: HTMLDialogElement = $state()
  const runId = $derived(metrics.runId)

  $effect(() => {
    runId
    dialog?.close()
  })
</script>

<button
  class="w-full rounded-md border border-base-300 bg-base-200 px-3 py-2 text-xs text-left flex flex-wrap items-center gap-x-4 gap-y-1 hover:bg-base-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
  aria-haspopup="dialog"
  aria-label="Open run summary"
  onclick={() => dialog.showModal()}
>
  <span class="font-medium">{metrics.status === 'running' ? 'Current run' : 'Last run'}</span>
  <span class="capitalize">{agentRunOutcome(metrics)}</span>
  <span class="tabular-nums">{agentRunElapsed(metrics)} elapsed</span>
  <span class="tabular-nums">{formatAgentTokenCount(metrics.totalTokens)} recorded tokens</span>
  <span>Tools: {agentRunToolSummary(metrics)}</span>
  {#if metrics.usageReconciled === false}<span class="text-warning">Partial usage</span>{/if}
  <span class="material-symbols-outlined text-base ml-auto" aria-hidden="true">open_in_full</span>
</button>

<dialog class="modal" bind:this={dialog} aria-label="Agent run summary">
  <div class="modal-box max-w-2xl">
    <div class="flex items-center justify-between gap-4 mb-4">
      <h2 class="text-lg font-semibold">Run summary</h2>
      <form method="dialog">
        <button class="btn btn-sm btn-ghost btn-circle" aria-label="Close run summary">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </form>
    </div>
    <div class="space-y-3 text-sm">
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
      <dl class="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 tabular-nums">
        <div>
          <dt class="opacity-60">Documentation calls</dt>
          <dd>{formatAgentTokenCount(metrics.documentationCalls)}</dd>
        </div>
        <div>
          <dt class="opacity-60">Unique documentation calls</dt>
          <dd>{formatAgentTokenCount(metrics.uniqueDocumentationCalls)}</dd>
        </div>
        <div>
          <dt class="opacity-60">Duplicate documentation calls</dt>
          <dd>{formatAgentTokenCount(metrics.duplicateDocumentationCalls)}</dd>
        </div>
        <div>
          <dt class="opacity-60">Documentation result characters</dt>
          <dd>{formatAgentTokenCount(metrics.documentationResultChars)}</dd>
        </div>
      </dl>
      <p class="opacity-60">
        Token totals may omit unreported usage; zero is not proof of no usage. Cache counts are
        included in input tokens. Unreported cache counts are unavailable.
        {#if metrics.usageReconciled === false}
          Partial checkpoint: usage from a round still executing tools or a provider request in
          flight is unavailable.
        {/if}
        {#if metrics.status === 'interrupted'}
          Elapsed time ends at the last recorded checkpoint; the closure time and unfinished tool
          outcomes are unknown.
        {:else if metrics.status === 'running'}
          Elapsed time is through the latest recorded checkpoint.
        {/if}
      </p>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop">
    <button aria-label="Dismiss run summary">close</button>
  </form>
</dialog>
