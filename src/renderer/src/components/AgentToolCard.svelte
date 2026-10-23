<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { AgentToolCall } from '../../../shared/agentTypes'
  import { agentToolLabel } from '../utils/agentToolLabel'

  let { call, children }: { call: AgentToolCall; children: Snippet } = $props()
  let expanded = $state(false)
  const approvalPending = $derived(call.status === 'waiting_approval')

  $effect(() => {
    if (approvalPending) expanded = true
  })
</script>

<details
  class="group/tool border border-base-300 rounded-md overflow-hidden"
  aria-label={`Tool call: ${agentToolLabel(call)}`}
  bind:open={expanded}
>
  <summary
    class="h-10 px-3 bg-base-200 flex items-center gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:-outline-offset-2"
  >
    <span class="material-symbols-outlined text-base" aria-hidden="true">build</span>
    <code class="text-sm font-semibold min-w-0 truncate" title={agentToolLabel(call)}
      >{agentToolLabel(call)}</code
    >
    <span
      class="badge badge-sm ml-auto shrink-0 {call.status === 'error'
        ? 'badge-error'
        : call.status === 'waiting_approval'
          ? 'badge-warning'
          : 'badge-ghost'}"
      >{call.status === 'reviewing' ? 'Reviewing change' : call.status.replace('_', ' ')}</span
    >
    <span
      class="material-symbols-outlined text-base shrink-0 transition-transform group-open/tool:rotate-180"
      aria-hidden="true">expand_more</span
    >
  </summary>
  {@render children()}
</details>
