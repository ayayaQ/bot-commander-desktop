<script lang="ts">
  import type { AgentValidationReport } from '../../../shared/agentValidationTypes'
  import {
    agentValidationReportView,
    type ValidationReportBinding,
    type ValidationReportTone
  } from '../utils/agentValidationReport'

  interface Props {
    report: AgentValidationReport
    binding?: ValidationReportBinding
    candidate?: unknown
  }

  let { report, binding, candidate }: Props = $props()
  let view = $derived(agentValidationReportView(report, binding, candidate))

  function badgeClass(tone: ValidationReportTone): string {
    if (tone === 'success') return 'badge-success'
    if (tone === 'error') return 'badge-error'
    return 'badge-warning'
  }
</script>

<section class="border-t border-base-300 text-xs" aria-label="Playground validation">
  <div class="px-3 py-2 bg-base-100 space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="material-symbols-outlined text-base" aria-hidden="true">science</span>
      <span class="text-sm font-semibold">Playground validation</span>
      <span class="badge badge-sm ml-auto {badgeClass(view.tone)}">{view.outcome}</span>
    </div>
    <p class="opacity-70">{view.summary}</p>
    <div class="flex flex-wrap gap-x-3 gap-y-1 opacity-70" aria-label="Validation coverage">
      {#each view.coverage as item (item.label)}
        <span>{item.label}: <span class="font-medium tabular-nums">{item.count}</span></span>
      {/each}
    </div>
    {#if view.warnings.length > 0}
      <ul class="space-y-1 text-warning">
        {#each view.warnings as warning}
          <li class="break-words">{warning}</li>
        {/each}
      </ul>
    {/if}
  </div>

  <details class="border-t border-base-300">
    <summary class="px-3 py-2 cursor-pointer opacity-70">
      Cases and assertions ({view.caseCount}
      {view.caseCount === 1 ? 'case' : 'cases'})
    </summary>
    <div class="max-h-96 overflow-y-auto divide-y divide-base-300">
      {#each view.cases as entry}
        <div class="px-3 py-3 space-y-3">
          <div class="flex items-center gap-2">
            <span class="font-semibold break-words min-w-0 grow">{entry.name}</span>
            <span class="badge badge-sm shrink-0 {badgeClass(entry.tone)}">{entry.outcome}</span>
          </div>
          {#each entry.steps as step}
            <div class="border-l-2 border-base-300 pl-3 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{step.label}</span>
                <span class="badge badge-sm {badgeClass(step.tone)}">{step.outcome}</span>
              </div>
              <p class="opacity-60">{step.execution}</p>
              {#if step.reason}
                <p class="break-words">{step.reason}</p>
              {/if}
              <div class="flex flex-wrap gap-x-3 gap-y-1 opacity-60" aria-label="Step effects">
                {#each step.effects as effect (effect.label)}
                  <span>{effect.label}: <span class="tabular-nums">{effect.count}</span></span>
                {/each}
              </div>
              <details>
                <summary class="cursor-pointer opacity-60">Effects and state-diff previews</summary>
                <div class="mt-2 space-y-2">
                  {#each step.effects.filter((effect) => effect.count > 0) as effect (effect.label)}
                    <div class="rounded-sm bg-base-200 p-2 space-y-1">
                      <div class="font-medium">{effect.label} ({effect.count})</div>
                      <pre
                        class="whitespace-pre-wrap break-words max-h-32 overflow-auto">{effect.preview}</pre>
                      {#if effect.hiddenItems > 0 || effect.truncated}
                        <p class="opacity-60">
                          Bounded JSON preview{effect.truncated
                            ? ' · text truncated'
                            : ''}{effect.hiddenItems > 0
                            ? ` · ${effect.hiddenItems} more items omitted`
                            : ''}
                        </p>
                      {/if}
                    </div>
                  {:else}
                    <p class="opacity-60">No effects or state changes recorded.</p>
                  {/each}
                </div>
              </details>
              {#each step.assertions as assertion}
                <div class="rounded-sm border border-base-300 p-2 space-y-2">
                  <div class="flex items-start gap-2">
                    <code class="break-all grow min-w-0">{assertion.path}</code>
                    <span
                      class="badge badge-sm shrink-0 {assertion.passed
                        ? 'badge-success'
                        : 'badge-error'}"
                    >
                      {assertion.passed ? 'Passed' : 'Failed'}
                    </span>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div class="min-w-0 rounded-sm bg-base-200 p-2">
                      <div class="text-[10px] uppercase opacity-55 mb-1">Expected</div>
                      <pre
                        class="whitespace-pre-wrap break-words max-h-24 overflow-auto">{assertion.expected}</pre>
                    </div>
                    <div class="min-w-0 rounded-sm bg-base-200 p-2">
                      <div class="text-[10px] uppercase opacity-55 mb-1">Actual</div>
                      <pre
                        class="whitespace-pre-wrap break-words max-h-24 overflow-auto">{assertion.actual}</pre>
                    </div>
                  </div>
                </div>
              {/each}
              {#if step.hiddenAssertions > 0}
                <p class="opacity-60">
                  {step.hiddenAssertions} more assertions omitted from this view
                </p>
              {/if}
              {#if step.errors.length > 0}
                <ul class="space-y-1 text-error">
                  {#each step.errors as error}
                    <li class="break-words">{error}</li>
                  {/each}
                </ul>
              {/if}
              {#if step.hiddenErrors > 0}
                <p class="opacity-60">{step.hiddenErrors} more errors omitted from this view</p>
              {/if}
              {#if step.trace.length > 0}
                <details>
                  <summary class="cursor-pointer opacity-60">Execution trace</summary>
                  <ul class="mt-1 space-y-1 font-mono opacity-70">
                    {#each step.trace as line}
                      <li class="whitespace-pre-wrap break-words">{line}</li>
                    {/each}
                  </ul>
                  {#if step.hiddenTrace > 0}
                    <p class="mt-1 opacity-60">
                      {step.hiddenTrace} more trace lines omitted from this view
                    </p>
                  {/if}
                </details>
              {/if}
            </div>
          {/each}
          {#if entry.hiddenSteps > 0}
            <p class="opacity-60">{entry.hiddenSteps} more steps omitted from this view</p>
          {/if}
        </div>
      {:else}
        <p class="px-3 pb-3 opacity-60">No validation cases ran.</p>
      {/each}
      {#if view.hiddenCases > 0}
        <p class="px-3 py-2 opacity-60">{view.hiddenCases} more cases omitted from this view</p>
      {/if}
    </div>
  </details>

  <details class="border-t border-base-300">
    <summary class="px-3 py-2 cursor-pointer opacity-70">Report identity and limitations</summary>
    <div class="px-3 pb-3 space-y-3 max-h-64 overflow-y-auto">
      <dl class="space-y-1">
        {#each view.identity as item (item.label)}
          <div>
            <dt class="inline opacity-55">{item.label}:</dt>
            <dd class="inline font-mono break-all">{item.value}</dd>
          </div>
        {/each}
      </dl>
      <ul class="space-y-1 opacity-70">
        {#each view.limitations as limitation}
          <li class="break-words">{limitation}</li>
        {/each}
      </ul>
      {#if view.hiddenLimitations > 0}
        <p class="opacity-60">{view.hiddenLimitations} more limitations omitted from this view</p>
      {/if}
    </div>
  </details>
</section>
