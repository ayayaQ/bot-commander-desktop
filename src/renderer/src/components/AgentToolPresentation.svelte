<script lang="ts">
  import {
    decodeToolPresentation,
    toolPresentationView,
    TOOL_PRESENTATION_LIMITS,
    type ToolPresentationView
  } from '@ayayaq/vivi/presentation'

  let {
    encoded,
    fallback,
    detailBytes = TOOL_PRESENTATION_LIMITS.detailBytes
  }: {
    encoded: string
    fallback?: Pick<ToolPresentationView, 'header' | 'warnings'>
    detailBytes?: number
  } = $props()
  // A replacement snapshot may update status while retaining the same call/card.
  // Only plain JSON is admitted, including after an IPC/persistence transfer.
  const snapshot = $derived.by(() => {
    try {
      return decodeToolPresentation(encoded)
    } catch {
      return null
    }
  })
  const view = $derived.by(() => {
    try {
      return snapshot ? toolPresentationView(snapshot, { collapsed: false, detailBytes }) : null
    } catch {
      return null
    }
  })
</script>

<section class="border-t border-base-300 text-xs" aria-label="Shared tool presentation">
  {#if view}
    <div class="p-3 space-y-1 break-all" aria-label="Tool status and provenance">
      {#each view.header as line}<div>{line}</div>{/each}
    </div>
    {#if view.warnings.length}
      <div
        class="px-3 pb-3 space-y-1 text-warning break-words"
        aria-label="Tool warnings"
        role="status"
      >
        {#each view.warnings as warning}<p>{warning}</p>{/each}
      </div>
    {/if}
    <div class="border-t border-base-300 pt-3" aria-label="Arguments / result details">
      {#each view.details as detail}
        <div class="px-3 pb-3">
          <div class="font-semibold mb-1">{detail.label}</div>
          <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words">{detail.text}</pre>
        </div>
      {/each}
    </div>
    {#if view.notice}<p class="px-3 pb-3 opacity-70">{view.notice}</p>{/if}
  {:else}
    {#if fallback}
      <div class="p-3 space-y-1 break-all" aria-label="Tool status and provenance">
        {#each fallback.header as line}<div>{line}</div>{/each}
      </div>
      <div
        class="px-3 pb-3 space-y-1 text-warning break-words"
        aria-label="Tool warnings"
        role="status"
      >
        {#each fallback.warnings as warning}<p>{warning}</p>{/each}
      </div>
    {/if}
    <p class="p-3 text-warning" role="status">
      Tool presentation is invalid or exceeds its display bounds. Details are unavailable; use the
      host status and review above. This display grants no permission to execute or retry.
    </p>
  {/if}
</section>
